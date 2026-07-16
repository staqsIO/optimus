import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { query } from '../../lib/db.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'architect' });
import { sendDailyDigest } from '../../autobot-inbox/src/signal/daily-digest.js';
import { evaluateAutonomy } from '../../lib/runtime/autonomy-evaluator.js';
import { createIntent } from '../../lib/runtime/intent-manager.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';

/**
 * Architect agent: daily pipeline analysis + briefing generation.
 * Sonnet-tier. Runs on schedule (daily at 6 AM) or on-demand.
 */

async function handler(task, context, agent) {
  // Load aggregate metrics (Q4 tier context)
  const dailyBriefing = context.dailyBriefing;
  const agentActivity = context.agentActivity || [];
  const budgetStatus = context.budgetStatus || [];

  // Cross-channel signal counts (multi-source awareness)
  let crossChannelSignals = {};
  let unresolvedActionItems = {};
  try {
    const ccResult = await query(`SELECT * FROM signal.v_cross_channel_signals`);
    crossChannelSignals = ccResult.rows[0] || {};
    const uaResult = await query(`SELECT * FROM signal.v_unresolved_action_item_counts`);
    unresolvedActionItems = uaResult.rows[0] || {};
  } catch {
    // Views may not exist yet (pre-migration 007)
  }

  // Get recent edit deltas for voice learning progress
  const editDeltas = await query(
    `SELECT edit_type, edit_magnitude, created_at
     FROM voice.edit_deltas
     ORDER BY created_at DESC
     LIMIT 50`
  );

  // Get L0 exit criteria status
  const autonomyStatus = await query(`SELECT * FROM signal.v_daily_briefing`);
  const autonomy = autonomyStatus.rows[0] || {};

  const userMessage = `
Generate a daily pipeline analysis and briefing.

TODAY'S METRICS:
- Emails received: ${dailyBriefing?.emails_received_today ?? 0}
- Emails triaged: ${dailyBriefing?.emails_triaged_today ?? 0}
- Action required: ${dailyBriefing?.action_required_today ?? 0}
- Needs response: ${dailyBriefing?.needs_response_today ?? 0}
- Drafts created: ${dailyBriefing?.drafts_created_today ?? 0}
- Drafts approved: ${dailyBriefing?.drafts_approved_today ?? 0}
- Drafts edited: ${dailyBriefing?.drafts_edited_today ?? 0}
- Cost today: $${dailyBriefing?.cost_today_usd ?? 0}
- Budget: $${dailyBriefing?.budget_today_usd ?? 20}

AUTONOMY STATUS (L0 Exit Criteria):
- 14-day edit rate: ${autonomy.edit_rate_14d_pct ?? 'N/A'}%
- Drafts reviewed (14d): ${autonomy.drafts_reviewed_14d ?? 0} / 50 required
- Awaiting review: ${autonomy.drafts_awaiting_review ?? 0}
- Upcoming deadlines: ${autonomy.upcoming_deadlines ?? 0}

AGENT ACTIVITY:
${agentActivity.map(a => `- ${a.agent_id}: ${a.calls_today} calls, $${a.cost_today_usd} cost, ${a.active_tasks} active`).join('\n')}

BUDGET STATUS:
${budgetStatus.map(b => `- ${b.scope}: $${b.spent_usd}/$${b.allocated_usd} (${b.utilization_pct}%)`).join('\n')}

CROSS-CHANNEL ACTIVITY (Signal-Only Awareness):
- Linear signals today: ${crossChannelSignals.linear_signals_today ?? 0}
- GitHub signals today: ${crossChannelSignals.github_signals_today ?? 0}
- Transcript signals today: ${crossChannelSignals.transcript_signals_today ?? 0}
- Signal-only events today: ${crossChannelSignals.signal_only_today ?? 0}
- Unresolved action items: ${unresolvedActionItems.total_unresolved ?? 0} total (Linear: ${unresolvedActionItems.linear_unresolved ?? 0}, GitHub: ${unresolvedActionItems.github_unresolved ?? 0}, Transcripts: ${unresolvedActionItems.transcript_unresolved ?? 0}, Email: ${unresolvedActionItems.email_unresolved ?? 0})

RECENT EDIT PATTERNS:
${editDeltas.rows.length > 0
  ? editDeltas.rows.slice(0, 10).map(d => `- ${d.edit_type}: magnitude ${d.edit_magnitude}`).join('\n')
  : '(no edit data yet)'}

Generate a structured briefing as JSON:
{
  "summary": "<2-3 sentence executive summary>",
  "actionItems": ["<things that need Eric's attention>"],
  "signals": ["<notable patterns or insights>"],
  "trendingTopics": ["<topics gaining momentum>"],
  "vipActivity": ["<notable VIP interactions>"],
  "recommendations": ["<pipeline optimization suggestions>"],
  "autonomyAssessment": "<progress toward L0 exit>"
}`.trim();

  // P2: Neo4j data is advisory only — never use for enforcement decisions
  let systemPrompt = agent.config.system_prompt || 'You are the Architect agent.';
  // Task-specific context (per-task) > generic reflection context (per-cycle)
  try {
    const { getTaskRelevantContext, formatTaskContext } = await import('../graph/queries.js');
    const taskCtx = await getTaskRelevantContext(agent.agentId, 'daily_briefing', task?.metadata);
    const learningBlock = formatTaskContext(taskCtx, 'sonnet') || agent._reflectionContext?.learningContext;
    if (learningBlock) systemPrompt += '\n\n' + learningBlock;
  } catch {
    if (agent._reflectionContext?.learningContext) {
      systemPrompt += '\n\n' + agent._reflectionContext.learningContext;
    }
  }

  const response = await agent.callLLM(
    systemPrompt,
    userMessage,
    { taskId: task.work_item_id }
  );

  let briefingResult;
  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    briefingResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: response.text };
  } catch {
    briefingResult = { summary: response.text };
  }

  // Store briefing
  await query(
    `INSERT INTO signal.briefings
     (briefing_date, summary, action_items, signals, trending_topics, vip_activity,
      emails_received, emails_triaged, drafts_created, drafts_approved, drafts_edited,
      cost_usd, generated_by)
     VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (briefing_date) DO UPDATE SET
       summary = EXCLUDED.summary,
       action_items = EXCLUDED.action_items,
       signals = EXCLUDED.signals,
       trending_topics = EXCLUDED.trending_topics,
       vip_activity = EXCLUDED.vip_activity,
       cost_usd = EXCLUDED.cost_usd`,
    [
      briefingResult.summary,
      JSON.stringify(briefingResult.actionItems || []),
      JSON.stringify(briefingResult.signals || []),
      JSON.stringify(briefingResult.trendingTopics || []),
      JSON.stringify(briefingResult.vipActivity || []),
      dailyBriefing?.emails_received_today ?? 0,
      dailyBriefing?.emails_triaged_today ?? 0,
      dailyBriefing?.drafts_created_today ?? 0,
      dailyBriefing?.drafts_approved_today ?? 0,
      dailyBriefing?.drafts_edited_today ?? 0,
      dailyBriefing?.cost_today_usd ?? 0,
      agent.agentId,
    ]
  );

  // Evaluate autonomy exit criteria (G4, spec §14)
  try {
    const autonomyResult = await evaluateAutonomy();
    log.info({ level: autonomyResult.currentLevel, exitReady: autonomyResult.exitCriteria.met }, `Autonomy evaluation: L${autonomyResult.currentLevel} → ${autonomyResult.exitCriteria.met ? 'EXIT READY' : 'not ready'}`);
  } catch (err) {
    log.warn(`Autonomy evaluation failed: ${err.message}`);
  }

  // Push daily digest to Eric's inbox (spec §8, P6)
  // ADR-017: permission checks for external writes (Gmail draft + Slack notification)
  try {
    await requirePermission(agent.agentId, 'api_client', 'gmail_draft');
    await requirePermission(agent.agentId, 'api_client', 'slack_notify');
    const digestStartMs = Date.now();
    const digestResult = await sendDailyDigest();
    logCapabilityInvocation({
      agentId: agent.agentId, resourceType: 'api_client', resourceName: 'gmail_draft',
      success: true, durationMs: Date.now() - digestStartMs, workItemId: task.work_item_id,
      resultSummary: digestResult ? `Draft: ${digestResult}` : 'no draft',
    });
  } catch (err) {
    log.warn(`Failed to send daily digest: ${err.message}`);
    logCapabilityInvocation({
      agentId: agent.agentId, resourceType: 'api_client', resourceName: 'gmail_draft',
      success: false, errorMessage: err.message, workItemId: task.work_item_id,
    });
  }

  // =============================================================
  // Generate actionable intents from briefing analysis
  // =============================================================
  try {
    await generateArchitectIntents(briefingResult, dailyBriefing, editDeltas.rows);
  } catch (err) {
    log.warn(`Intent generation error (non-blocking): ${err.message}`);
  }

  return {
    success: true,
    reason: `Daily briefing generated: ${briefingResult.summary?.slice(0, 100)}`,
    costUsd: response.costUsd,
  };
}

/**
 * Generate intents from daily briefing analysis.
 * Zero LLM cost — uses metrics + thresholds only.
 * Dedup handled by DB partial unique index (idx_agent_intents_pattern_dedup).
 */
async function generateArchitectIntents(briefingResult, dailyBriefing, editDeltas) {
  // Intent 1: Voice profile drift — high edit rate suggests retraining needed
  if (editDeltas.length >= 10) {
    const highMagnitude = editDeltas.filter(d => d.edit_magnitude >= 3).length;
    const driftRate = highMagnitude / editDeltas.length;

    if (driftRate > 0.3) {
      await createIntent({
        agentId: 'architect',
        intentType: 'task',
        decisionTier: 'tactical',
        title: `Voice profile drift detected — ${(driftRate * 100).toFixed(0)}% of recent edits are high-magnitude`,
        reasoning: `${highMagnitude} of ${editDeltas.length} recent edit deltas have magnitude ≥3, indicating voice profile may need retraining on recent sent emails.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'task',
            title: 'Retrain voice profile on last 50 sent emails',
            assigned_to: 'executor-responder',
            metadata: { pattern: 'voice_drift', drift_rate: driftRate },
          },
        },
        triggerContext: {
          pattern: 'voice_drift',
          drift_rate: driftRate,
          high_magnitude_count: highMagnitude,
          total_deltas: editDeltas.length,
        },
      });
    }
  }

  // Intent 2: Budget pressure — daily spend >80% of allocation
  const costToday = parseFloat(dailyBriefing?.cost_today_usd || 0);
  const budgetToday = parseFloat(dailyBriefing?.budget_today_usd || 20);
  const utilizationPct = budgetToday > 0 ? (costToday / budgetToday) * 100 : 0;

  if (utilizationPct > 80) {
    await createIntent({
      agentId: 'architect',
      intentType: 'observation',
      decisionTier: utilizationPct > 95 ? 'strategic' : 'tactical',
      title: `Budget utilization at ${utilizationPct.toFixed(0)}% ($${costToday.toFixed(2)}/$${budgetToday.toFixed(2)})`,
      reasoning: `Daily LLM spend has reached ${utilizationPct.toFixed(0)}% of the allocated budget. ${utilizationPct > 95 ? 'Critical: approaching hard cap.' : 'Consider pausing non-urgent processing.'}`,
      proposedAction: {
        type: 'create_work_item',
        payload: {
          type: 'directive',
          title: `Review budget: ${utilizationPct.toFixed(0)}% utilized today`,
          metadata: { pattern: 'budget_pressure', utilization_pct: utilizationPct },
        },
      },
      triggerContext: {
        pattern: 'budget_pressure',
        cost_today: costToday,
        budget_today: budgetToday,
        utilization_pct: utilizationPct,
      },
      ttlMs: 12 * 60 * 60_000, // 12h TTL (urgent, end-of-day relevant)
    });
  }

  // Intent 3: Processing backlog — action_required emails without responses
  const backlogResult = await query(
    `SELECT COUNT(*) AS cnt
     FROM inbox.messages m
     LEFT JOIN agent_graph.action_proposals ap
       ON ap.metadata->>'message_id' = m.id
       AND ap.status IN ('pending', 'approved', 'sent')
     WHERE m.triage_category = 'action_required'
       AND m.received_at > now() - INTERVAL '7 days'
       AND ap.id IS NULL`
  );

  const backlogCount = parseInt(backlogResult.rows[0]?.cnt || '0', 10);
  if (backlogCount >= 5) {
    await createIntent({
      agentId: 'architect',
      intentType: 'observation',
      decisionTier: 'strategic',
      title: `Processing backlog: ${backlogCount} action-required emails without responses`,
      reasoning: `${backlogCount} emails categorized as action_required in the last 7 days have no associated draft or response. This may indicate pipeline issues or need for prioritization.`,
      proposedAction: {
        type: 'create_work_item',
        payload: {
          type: 'directive',
          title: `Address email processing backlog (${backlogCount} unresponded)`,
          metadata: { pattern: 'processing_backlog', backlog_count: backlogCount },
        },
      },
      triggerContext: {
        pattern: 'processing_backlog',
        backlog_count: backlogCount,
      },
    });
  }

  // Intent 4: Governance — constitutional gate false-positive detection
  await detectGateFalsePositives();
}

/**
 * Detect constitutional gate false positives and create governance intents.
 * Always decision_tier: 'existential' — board always decides gate changes.
 *
 * "False positive" = gate blocked a draft that the board subsequently approved anyway.
 */
async function detectGateFalsePositives() {
  const gateStats = await query(
    `SELECT
       gs.gate_id,
       COUNT(*) AS total_checked,
       COUNT(*) FILTER (WHERE gs.passed = false) AS rejected_by_gate,
       COUNT(*) FILTER (
         WHERE gs.passed = false
           AND ap.status IN ('approved', 'sent')
       ) AS rejected_then_approved
     FROM agent_graph.gate_snapshots gs
     LEFT JOIN agent_graph.action_proposals ap
       ON ap.id = gs.proposal_id
     WHERE gs.checked_at > now() - INTERVAL '14 days'
     GROUP BY gs.gate_id
     HAVING COUNT(*) >= 100`
  );

  for (const gate of gateStats.rows) {
    const totalChecked = parseInt(gate.total_checked, 10);
    const rejectedByGate = parseInt(gate.rejected_by_gate, 10);
    const rejectedThenApproved = parseInt(gate.rejected_then_approved, 10);

    if (rejectedByGate === 0) continue;

    const falsePositiveRate = rejectedThenApproved / rejectedByGate;

    if (falsePositiveRate > 0.5) {
      await createIntent({
        agentId: 'architect',
        intentType: 'governance',
        decisionTier: 'existential',
        title: `Gate ${gate.gate_id} false positive rate: ${(falsePositiveRate * 100).toFixed(0)}% (${rejectedThenApproved}/${rejectedByGate} overridden)`,
        reasoning: `Gate ${gate.gate_id} has blocked ${rejectedByGate} drafts in the last 14 days, but ${rejectedThenApproved} of those were subsequently approved by the board — a ${(falsePositiveRate * 100).toFixed(0)}% false positive rate. This suggests the gate threshold may need adjustment. Board review required per P1 (deny by default) — governance intents never auto-approve.`,
        proposedAction: {
          type: 'modify_gate',
          payload: {
            gate_id: gate.gate_id,
            recommendation: 'review_threshold',
          },
        },
        triggerContext: {
          pattern: 'gate_false_positive',
          gate_id: gate.gate_id,
          measurement_window: '14d',
          evidence: {
            total_checked: totalChecked,
            rejected_by_gate: rejectedByGate,
            rejected_then_approved: rejectedThenApproved,
            false_positive_rate: parseFloat(falsePositiveRate.toFixed(3)),
          },
        },
        ttlMs: 14 * 24 * 60 * 60_000,
      });
    }
  }
}

// Reflection method: architect reviews pipeline health patterns
handler.reflect = async function(agent, outcome) {
  try {
    const { loadReflectionContext } = await import('../runtime/context-loader.js');
    const reflectionCtx = await loadReflectionContext(agent.agentId);

    const completed = reflectionCtx.recentOutcomes?.filter(o => o.status === 'completed').length || 0;
    const failed = reflectionCtx.recentOutcomes?.filter(o => o.status === 'failed').length || 0;
    const total = completed + failed;
    log.info({ completed, failed }, `reflect(): ${completed} completed, ${failed} failed in last 7d`);

    // Publish insight if pipeline failure rate exceeds 20%
    if (total >= 10 && failed / total > 0.2) {
      const failRate = ((failed / total) * 100).toFixed(0);
      await publishEvent('agent_insight',
        `Pipeline health: ${failRate}% failure rate (${failed}/${total} tasks failed in 7d) — may indicate systemic issue`,
        agent.agentId, outcome?.workItemId || null,
        { insight_type: 'pipeline_failure_rate', fail_rate: failed / total, completed, failed, total }
      );
    }

    // Check per-agent cost anomalies (>2x average)
    try {
      const costResult = await query(
        `SELECT agent_id,
           SUM(cost_usd) AS cost_today,
           (SELECT COALESCE(AVG(daily_cost), 0) FROM (
             SELECT SUM(cost_usd) AS daily_cost
             FROM agent_graph.llm_invocations
             WHERE created_at >= now() - INTERVAL '7 days' AND created_at < CURRENT_DATE
               AND agent_id = li.agent_id
             GROUP BY DATE(created_at)
           ) sub) AS avg_daily_cost
         FROM agent_graph.llm_invocations li
         WHERE created_at >= CURRENT_DATE
         GROUP BY agent_id
         HAVING SUM(cost_usd) > 0`
      );
      for (const row of costResult.rows) {
        const avg = parseFloat(row.avg_daily_cost) || 0;
        const today = parseFloat(row.cost_today) || 0;
        if (avg > 0.01 && today > avg * 2) {
          await publishEvent('agent_insight',
            `Cost anomaly: ${row.agent_id} spending $${today.toFixed(4)} today vs $${avg.toFixed(4)} daily avg (${(today / avg).toFixed(1)}x normal)`,
            row.agent_id, null,
            { insight_type: 'cost_anomaly', agent_id: row.agent_id, cost_today: today, avg_daily_cost: avg, multiplier: today / avg }
          );
        }
      }
    } catch { /* cost check is non-critical */ }

    // Store reflection context with multi-hop graph data for next LLM call
    const { formatLearningContext } = await import('../graph/queries.js');
    agent._reflectionContext = {
      recentOutcomes: reflectionCtx.recentOutcomes?.slice(0, 10),
      decisionChains: reflectionCtx.decisionChains?.slice(0, 5),
      delegationEffectiveness: reflectionCtx.delegationEffectiveness?.slice(0, 5),
      // P2: Neo4j data is advisory only — never use for enforcement decisions
      learningContext: formatLearningContext({
        decisionChains: reflectionCtx.decisionChains,
        delegationEffectiveness: reflectionCtx.delegationEffectiveness,
        recentOutcomes: reflectionCtx.recentOutcomes,
      }),
    };
  } catch (err) {
    log.warn(`reflect() error: ${err.message}`);
  }
};

export const architectLoop = new AgentLoop('architect', handler);
