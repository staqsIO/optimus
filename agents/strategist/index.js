import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { query } from '../../lib/db.js';
import { classifyDecisionTier, evaluateTactical } from '../../autobot-inbox/src/strategy/evaluation-protocol.js';
import { createIntent } from '../../lib/runtime/intent-manager.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';

/**
 * Strategist agent: priority scoring + strategy recommendations.
 * Opus-tier. Operates in SUGGEST mode — recommends, board decides.
 * Skipped entirely for fyi/noise (saves 60%+ of cost).
 */

// STAQPRO-311 Phase 3: source-typed citations from context.knowledgeContext.
// Inlined per agent — no shared helper yet (Neo Architect: extract only
// after pattern stabilizes across 3+ agents). Same format as responder's
// helper; keep in sync until the abstraction is justified.
export function formatKnowledgeContext(kc) {
  if (!kc?.items?.length) return '';
  const lines = ['RELEVANT KNOWLEDGE (org context — treat as background, cite as [wiki:...] / [doc:...] only if you draw on it):'];
  for (const item of kc.items) {
    if (item.sourceType === 'wiki_pages') {
      lines.push(`[wiki:${item.id}] ${item.title || ''}`.trim());
    } else {
      lines.push(`[doc:${item.id}]`);
    }
    if (item.excerpt) lines.push(item.excerpt);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handler(task, context, agent) {
  const email = context.email;
  if (!email) return { success: false, reason: 'No email context' };

  // Skip for fyi/noise (cost optimization)
  if (['fyi', 'noise'].includes(email.triage_category)) {
    return { success: true, reason: `Skipped: email is ${email.triage_category}` };
  }

  // Body fetched by context-loader via adapter (D1: metadata only in DB)
  const emailBody = context.emailBody;

  const senderRegister = context.workItem?.metadata?.sender_register;

  const contactInfo = context.contact
    ? `Contact: ${context.contact.name || email.from_address} (${context.contact.contact_type}, VIP: ${context.contact.is_vip})`
    : `Contact: Unknown sender (${email.from_address})`;

  const signalInfo = (context.signals || [])
    .map(s => {
      const dir = s.direction ? ` [${s.direction}]` : '';
      const dom = s.domain && s.domain !== 'general' ? ` (${s.domain})` : '';
      return `- ${s.signal_type}${dir}${dom}: ${s.content}`;
    })
    .join('\n');

  // Retrieve KB context — past threads, contracts, briefings involving this
  // sender or topic. Best-effort: failures must never block priority scoring.
  let priorContextSection = '';
  try {
    const { retrieveContext } = await import('../../lib/rag/retriever.js');
    const queryText = [
      email.from_name,
      email.from_address,
      email.subject,
      (emailBody || email.snippet || '').slice(0, 500),
    ].filter(Boolean).join(' ');
    // Worktree 1 (RAG tenancy hardening): Strategist tier is in
    // ORG_SCOPE_ALLOWED_TIERS — priority scoring needs visibility across
    // every board member's corpus, not just the message owner's.
    // Phase-2 tenancy: agent has no board viewer → org-scope to Staqs via
    // syntheticPrincipal.readOrgIds so match_chunks fails closed on owner_org_id.
    const { CURRENT_ORG_READ_SCOPE } = await import('../../lib/tenancy/scope.js');
    const ragResult = await retrieveContext(
      queryText,
      { matchCount: 6 },
      {
        org: true,
        agentId: 'strategist',
        readOrgIds: CURRENT_ORG_READ_SCOPE,
      }
    );
    if (ragResult?.answer) {
      priorContextSection = `\nPRIOR CONTEXT (from knowledge base — past threads, commitments, briefings):\n${ragResult.answer}\n`;
    }
  } catch {
    /* RAG offline or no embedding provider — proceed without prior context */
  }

  // STAQPRO-311 Phase 3: compiled wiki from context.knowledgeContext.
  // Empty when context-loader Phase 2 didn't find any matching pages.
  const knowledgeSection = formatKnowledgeContext(context.knowledgeContext);

  const userMessage = `
Analyze this email and provide a strategy recommendation.

FROM: ${email.from_name || email.from_address}
SUBJECT: ${email.subject}
RECEIVED: ${email.received_at}
TRIAGE: ${email.triage_category}
${contactInfo}

EXTRACTED SIGNALS:
${signalInfo || '(none)'}
${senderRegister ? `\nSENDER REGISTER: formality=${senderRegister.formality} (${senderRegister.register})` : ''}${priorContextSection}${knowledgeSection ? `\n${knowledgeSection}\n` : ''}
EMAIL BODY:
${emailBody || email.snippet}

SIGNAL ENRICHMENT:
Review the extracted signals above. For each signal, assess whether the triage agent got the direction right (inbound vs outbound). If you see corrections, include them in signalEnrichments. Also flag any cross-email patterns (e.g., this is a follow-up to a previous ask, or escalation from the same sender).

Provide your response as JSON:
{
  "priorityScore": <0-100>,
  "priorityReason": "<why this priority>",
  "strategy": "<recommended approach>",
  "responseGuidance": "<specific guidance for the responder>",
  "flags": ["<any G2/G7 concerns>"],
  "suggestedTone": "<formal|casual|technical|friendly>",
  "urgency": "<routine|normal|urgent|critical>",
  "signalEnrichments": [
    {
      "signalContent": "<content of the signal being enriched>",
      "correctedDirection": "inbound" | "outbound" | "both" | null,
      "correctedDomain": "general" | "financial" | "legal" | "scheduling" | null,
      "pattern": "<cross-email pattern if detected, e.g. 'follow-up #3 from this sender', null otherwise>"
    }
  ]
}`.trim();

  // P2: Neo4j data is advisory only — never use for enforcement decisions
  let systemPrompt = agent.config.system_prompt || 'You are the Strategist agent.';
  // Task-specific context (per-task) > generic reflection context (per-cycle)
  try {
    const { getTaskRelevantContext, formatTaskContext } = await import('../../lib/graph/queries.js');
    const taskCtx = await getTaskRelevantContext(agent.agentId, 'strategy', task?.metadata);
    const learningBlock = formatTaskContext(taskCtx, 'opus') || agent._reflectionContext?.learningContext;
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

  // Parse strategy recommendation
  let recommendation;
  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    recommendation = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: response.text };
  } catch {
    recommendation = { raw: response.text };
  }

  // Store strategic decision — map LLM output to schema columns
  // decision_type: tactical (routine email), strategic (VIP/high-priority), existential (G2/G7 flagged)
  const hasFlags = (recommendation.flags || []).length > 0;
  const decisionType = hasFlags ? 'existential'
    : (recommendation.priorityScore > 80 ? 'strategic' : 'tactical');

  // recommendation column must be one of: proceed, defer, reject, escalate
  const recMap = { routine: 'proceed', normal: 'proceed', urgent: 'proceed', critical: 'escalate' };
  const recValue = hasFlags ? 'escalate'
    : (recMap[recommendation.urgency] || 'proceed');

  const perspectiveScores = {
    priorityScore: recommendation.priorityScore,
    urgency: recommendation.urgency,
    suggestedTone: recommendation.suggestedTone,
    flags: recommendation.flags,
    responseGuidance: recommendation.responseGuidance,
  };

  // Include reflection context in decision metadata if available
  const decisionPerspective = { ...perspectiveScores };
  if (agent._reflectionContext) {
    decisionPerspective.informed_by = {
      intent_match_rates: agent._reflectionContext.intentMatchRates?.length || 0,
      recent_outcome_count: agent._reflectionContext.recentOutcomes?.length || 0,
      graph_pattern_count: agent._reflectionContext.graphPatterns?.length || 0,
    };
  }

  const decisionResult = await query(
    `INSERT INTO agent_graph.strategic_decisions
     (work_item_id, agent_id, decision_type, proposed_action, rationale,
      confidence, recommendation, perspective_scores)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      task.work_item_id,
      agent.agentId,
      decisionType,
      recommendation.strategy || 'standard response',
      recommendation.priorityReason || null,
      Math.min(5, Math.max(1, Math.round((recommendation.priorityScore || 50) / 20))),
      recValue,
      JSON.stringify(decisionPerspective),
    ]
  );

  const decisionId = decisionResult.rows[0].id;

  // Evaluation protocol integration (shadow mode — logged, never blocks pipeline)
  try {
    const workItem = context.workItem;
    const tier = classifyDecisionTier(workItem);
    if (tier === 'tactical') {
      const evalResult = await evaluateTactical(
        recommendation.strategy || 'standard response',
        { decisionId, workItemId: task.work_item_id }
      );
      console.log(
        `[strategist] Evaluation (shadow): tier=${tier}, rec=${evalResult.recommendation}, confidence=${evalResult.confidence}, cost=$${evalResult.costUsd?.toFixed(4) || '0'}`
      );
      await query(
        `UPDATE agent_graph.strategic_decisions
         SET perspective_scores = $1
         WHERE id = $2`,
        [
          JSON.stringify({
            ...decisionPerspective,
            evaluation: {
              tier,
              evaluationId: evalResult.evaluationId,
              recommendation: evalResult.recommendation,
              confidence: evalResult.confidence,
              scores: evalResult.scores,
              rationale: evalResult.rationale,
            },
          }),
          decisionId,
        ]
      );
    } else {
      console.log(`[strategist] Evaluation (shadow): tier=${tier}, skipped (non-tactical tiers not yet wired)`);
    }
  } catch (evalErr) {
    console.warn(`[strategist] Evaluation protocol error (shadow, non-blocking):`, evalErr.message);
  }

  // Apply signal enrichments from Strategist (ADR-014)
  const enrichments = recommendation.signalEnrichments || [];
  if (enrichments.length > 0 && context.signals?.length > 0) {
    for (const enrichment of enrichments) {
      if (!enrichment.signalContent) continue;
      // Match enrichment to original signal by content substring
      const matchingSignal = context.signals.find(s =>
        s.content && enrichment.signalContent &&
        s.content.toLowerCase().includes(enrichment.signalContent.toLowerCase().slice(0, 40))
      );
      if (!matchingSignal) continue;

      const updates = [];
      const params = [];
      if (enrichment.correctedDirection && ['inbound', 'outbound', 'both'].includes(enrichment.correctedDirection)) {
        params.push(enrichment.correctedDirection);
        updates.push(`direction = $${params.length}`);
      }
      if (enrichment.correctedDomain && ['general', 'financial', 'legal', 'scheduling'].includes(enrichment.correctedDomain)) {
        params.push(enrichment.correctedDomain);
        updates.push(`domain = $${params.length}`);
      }
      if (enrichment.pattern) {
        params.push(JSON.stringify({ strategist_pattern: enrichment.pattern }));
        updates.push(`metadata = metadata || $${params.length}::jsonb`);
      }
      if (updates.length > 0) {
        params.push(matchingSignal.id);
        await query(
          `UPDATE inbox.signals SET ${updates.join(', ')} WHERE id = $${params.length}`,
          params
        );
      }
    }
  }

  // Update email priority score
  if (recommendation.priorityScore != null) {
    await query(
      `UPDATE inbox.messages SET priority_score = $1 WHERE id = $2`,
      [recommendation.priorityScore, email.id]
    );
  }

  // Store strategy result in metadata for orchestrator LLM routing
  await query(
    `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
    [JSON.stringify({
      strategy_result: {
        recommendation: recommendation.strategy,
        responseGuidance: recommendation.responseGuidance,
        suggestedTone: recommendation.suggestedTone,
        urgency: recommendation.urgency,
        priorityScore: recommendation.priorityScore,
        flags: recommendation.flags,
      },
      response_needed: ['action_required', 'needs_response'].includes(email.triage_category),
    }), task.work_item_id]
  );

  // =============================================================
  // Generate actionable intents from strategy analysis
  // =============================================================
  try {
    await detectPatternsAndCreateIntents(email, recommendation, context);
  } catch (err) {
    console.warn(`[strategist] Intent generation error (non-blocking):`, err.message);
  }

  return {
    success: true,
    reason: `Strategy: priority=${recommendation.priorityScore}, urgency=${recommendation.urgency}`,
    costUsd: response.costUsd,
  };
}

/**
 * Detect cross-email patterns and create intents.
 * Zero LLM cost — uses DB queries + thresholds only.
 * Dedup handled by DB partial unique index (idx_agent_intents_pattern_dedup).
 */
async function detectPatternsAndCreateIntents(email, recommendation, context) {
  const contactId = context.contact?.id;

  // Intent 1: Escalating urgency — same sender, multiple urgent emails in short window
  if (contactId && recommendation.urgency === 'critical') {
    const recentUrgent = await query(
      `SELECT COUNT(*) AS cnt
       FROM inbox.messages m
       JOIN agent_graph.work_items wi ON wi.metadata->>'message_id' = m.id::text
       JOIN agent_graph.strategic_decisions sd ON sd.work_item_id = wi.id
       WHERE m.from_address = $1
         AND m.received_at > now() - INTERVAL '48 hours'
         AND sd.perspective_scores->>'urgency' IN ('urgent', 'critical')`,
      [email.from_address]
    );

    const urgentCount = parseInt(recentUrgent.rows[0]?.cnt || '0', 10);
    if (urgentCount >= 3) {
      await createIntent({
        agentId: 'strategist',
        intentType: 'observation',
        decisionTier: 'strategic',
        title: `Escalating urgency from ${email.from_name || email.from_address} — ${urgentCount} urgent emails in 48h`,
        reasoning: `${urgentCount} emails from this sender in the last 48 hours have been rated urgent/critical. This may indicate an escalation pattern requiring proactive outreach.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'directive',
            title: `Review escalating urgency from ${email.from_name || email.from_address}`,
            metadata: { pattern: 'escalating_urgency', contact_id: contactId },
          },
        },
        triggerContext: {
          pattern: 'escalating_urgency',
          contact_id: contactId,
          urgent_count_48h: urgentCount,
        },
      });
    }
  }

  // Intent 2: Unanswered thread — action_required email with no response after 48h
  if (email.triage_category === 'action_required') {
    const unanswered = await query(
      `SELECT COUNT(*) AS cnt
       FROM inbox.messages m
       LEFT JOIN agent_graph.action_proposals ap
         ON ap.metadata->>'message_id' = m.id::text
         AND ap.status IN ('pending', 'approved', 'sent')
       WHERE m.thread_id = $1
         AND m.triage_category = 'action_required'
         AND m.received_at < now() - INTERVAL '48 hours'
         AND ap.id IS NULL`,
      [email.thread_id]
    );

    const unansweredCount = parseInt(unanswered.rows[0]?.cnt || '0', 10);
    if (unansweredCount >= 1) {
      await createIntent({
        agentId: 'strategist',
        intentType: 'observation',
        decisionTier: 'tactical',
        title: `Unanswered thread: "${email.subject}" (${unansweredCount} action-required messages without response)`,
        reasoning: `Thread "${email.subject}" has ${unansweredCount} action-required email(s) older than 48 hours with no associated draft or response.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'task',
            title: `Draft response for unanswered thread: "${email.subject}"`,
            assigned_to: 'executor-responder',
            metadata: { pattern: 'unanswered_thread', message_id: email.id },
          },
        },
        triggerContext: {
          pattern: 'unanswered_thread',
          message_id: email.id,
          unanswered_count: unansweredCount,
        },
      });
    }
  }

  // Intent 3: Deadline cluster — multiple upcoming deadlines from same contact
  if (contactId) {
    const deadlineSignals = await query(
      `SELECT COUNT(*) AS cnt
       FROM inbox.signals s
       JOIN inbox.messages m ON s.message_id = m.id
       WHERE s.signal_type = 'deadline'
         AND s.direction = 'inbound'
         AND m.from_address = $1
         AND s.created_at > now() - INTERVAL '7 days'`,
      [email.from_address]
    );

    const deadlineCount = parseInt(deadlineSignals.rows[0]?.cnt || '0', 10);
    if (deadlineCount >= 3) {
      await createIntent({
        agentId: 'strategist',
        intentType: 'observation',
        decisionTier: 'strategic',
        title: `Deadline cluster from ${email.from_name || email.from_address} — ${deadlineCount} deadline signals in 7 days`,
        reasoning: `${deadlineCount} deadline signals detected from this contact in the last 7 days. Multiple concurrent deadlines may require consolidated planning.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'directive',
            title: `Review deadline cluster from ${email.from_name || email.from_address}`,
            metadata: { pattern: 'deadline_cluster', contact_id: contactId },
          },
        },
        triggerContext: {
          pattern: 'deadline_cluster',
          contact_id: contactId,
          deadline_count_7d: deadlineCount,
        },
      });
    }
  }
}

// Reflection method: strategist reviews its own decision patterns
handler.reflect = async function(agent, outcome) {
  try {
    const { loadReflectionContext } = await import('../../lib/runtime/context-loader.js');
    const reflectionCtx = await loadReflectionContext(agent.agentId);

    if (reflectionCtx.intentMatchRate.length > 0) {
      const rates = reflectionCtx.intentMatchRate.map(r => `${r.intent_type}: ${(r.match_rate * 100).toFixed(0)}%`).join(', ');
      console.log(`[strategist] reflect(): intent match rates — ${rates}`);

      // Publish insight if any intent match rate drops below 60%
      for (const r of reflectionCtx.intentMatchRate) {
        const matchPct = (r.match_rate * 100);
        if (matchPct < 60 && r.total >= 5) {
          await publishEvent('agent_insight',
            `Strategist intent match rate for "${r.intent_type}" dropped to ${matchPct.toFixed(0)}% (${r.approved}/${r.total} approved) — board may be overriding recommendations`,
            agent.agentId, outcome?.workItemId || null,
            { insight_type: 'match_rate_decline', intent_type: r.intent_type, match_rate: r.match_rate, approved: r.approved, total: r.total }
          );
        }
      }
    }

    // Store reflection context with multi-hop graph data for next LLM call
    const { formatLearningContext } = await import('../../lib/graph/queries.js');
    agent._reflectionContext = {
      intentMatchRates: reflectionCtx.intentMatchRate,
      recentOutcomes: reflectionCtx.recentOutcomes?.slice(0, 5),
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
    console.warn(`[strategist] reflect() error:`, err.message);
  }
};

export const strategistLoop = new AgentLoop('strategist', handler);
