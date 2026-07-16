import { query } from '../../db.js';
import { getEscalationLevel } from '../escalation-manager.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
import { getCapability, hasCapability } from '../capability-registry.js';
const log = createLogger('runtime/guard-check');

const gates = getConfig('gates');

// OSS baseline + private overlay. The gate regexes shipped in config/gates.json
// are the PUBLIC baseline. Once the patterns are open source they become evadable,
// so production can harden detection beyond the published set by supplying
// G2_PATTERNS_EXTRA / G7_PATTERNS_EXTRA — newline-delimited regex source strings —
// via env, without ever exposing those extra patterns in the open-source tree.
// Env is read at call time so the overlay needs no code change or restart to add.
function gatePatterns(gateKey, envVar) {
  const base = gates.gates[gateKey].params.patterns;
  const extra = (process.env[envVar] || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const compiled = [];
  for (const p of [...base, ...extra]) {
    try {
      compiled.push(new RegExp(p, 'i'));
    } catch {
      // An invalid pattern can only reduce coverage, never crash the gate —
      // G2/G7 run on every outbound draft.
      console.warn(`[guard-check] ${envVar}: skipping invalid regex ${JSON.stringify(p)}`);
    }
  }
  return compiled;
}

/**
 * Clamp a raw cosine-similarity tone score to the [0, 1] domain enforced by
 * the agent_graph.action_proposals.tone_score CHECK constraint.
 *
 * Raw cosine similarity is in [-1, 1]; negative values are still meaningful
 * for the *gate* (they fail tone match) but cannot be persisted because the
 * column CHECK rejects them. This helper is the single coercion boundary —
 * tested in autobot-inbox/test/db-checks-property.test.js to prevent
 * regressions of the bug class fixed in PR #150.
 *
 * @param {number} rawSimilarity - cosine similarity in [-1, 1]
 * @returns {number} value in [0, 1] rounded to 2 decimals
 */
export function clampToneScoreForPersistence(rawSimilarity) {
  if (typeof rawSimilarity !== 'number' || !Number.isFinite(rawSimilarity)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Math.round(rawSimilarity * 100) / 100));
}

/**
 * Atomic guard check. Called WITHIN the same transaction as transition_state.
 * P2: Infrastructure enforces, prompts advise.
 *
 * @param {Object} opts
 * @param {string} opts.action - What the agent wants to do
 * @param {string} opts.agentId - Who is doing it
 * @param {string} opts.configHash - SHA256 of agent config at time of action
 * @param {string} [opts.taskId] - Related work item
 * @param {number} [opts.estimatedCostUsd] - Expected cost of this action
 * @param {Object} [opts.context] - Additional context for gate checks
 * @param {pg.Client} [opts.client] - Transaction client (for atomic execution)
 * @returns {Promise<{allowed: boolean, failedChecks: string[], reason: string}>}
 */
export async function guardCheck({
  action,
  agentId,
  configHash,
  taskId = null,
  estimatedCostUsd = 0,
  context = {},
  client = null,
}) {
  const failedChecks = [];
  const queryFn = client
    ? (text, params) => client.query(text, params)
    : (text, params) => query(text, params);

  // G1: Budget check — atomic UPDATE...WHERE (spec §5)
  // Uses reserve_budget() which atomically reserves cost within the budget ceiling.
  // Two concurrent agents CANNOT both pass — the UPDATE...WHERE prevents it.
  // Account-aware: checks BOTH global AND per-account ceilings (008-multi-account.sql).
  // Campaign-aware (ADR-021): campaign iteration work_items route to campaign budget pool.
  const accountId = context.accountId || null;
  if (estimatedCostUsd > 0) {
    // ADR-021: Check if this work_item belongs to a campaign (parent chain)
    let campaignId = null;
    if (taskId) {
      const campaignCheck = await queryFn(
        `SELECT c.id AS campaign_id
         FROM agent_graph.work_items w
         JOIN agent_graph.campaigns c ON c.work_item_id = w.parent_id
         WHERE w.id = $1
         UNION
         SELECT c.id AS campaign_id
         FROM agent_graph.campaigns c
         WHERE c.work_item_id = $1
         LIMIT 1`,
        [taskId]
      );
      campaignId = campaignCheck.rows[0]?.campaign_id || null;
    }

    if (campaignId) {
      // Campaign budget path: reserve from campaign envelope (separate pool)
      const reserveResult = await queryFn(
        `SELECT agent_graph.reserve_campaign_budget($1, $2) as reserved`,
        [campaignId, estimatedCostUsd]
      );

      if (!reserveResult.rows[0]?.reserved) {
        failedChecks.push('G1_campaign_budget_exceeded');
      } else {
        context._budgetReserved = estimatedCostUsd;
        context._campaignId = campaignId;
      }
    } else {
      // Standard operational budget path
      const reserveResult = await queryFn(
        `SELECT agent_graph.reserve_budget($1, $2) as reserved`,
        [estimatedCostUsd, accountId]
      );

      if (!reserveResult.rows[0]?.reserved) {
        failedChecks.push('G1_budget_exceeded');
      } else {
        // Track that we reserved so we can release on failure
        context._budgetReserved = estimatedCostUsd;
        context._budgetAccountId = accountId;
      }
    }

    // Check warning threshold (global budget) — skip for campaign work_items
    if (!campaignId) {
      const budgetResult = await queryFn(
        `SELECT allocated_usd, spent_usd, reserved_usd
         FROM agent_graph.budgets
         WHERE scope = 'daily' AND period_start = CURRENT_DATE
           AND account_id IS NULL
         LIMIT 1`,
        []
      );
      if (budgetResult.rows.length > 0) {
        const budget = budgetResult.rows[0];
        const warningThreshold = parseFloat(budget.allocated_usd) * (gates.gates.G1.params.warningThresholdPct / 100);
        if (parseFloat(budget.spent_usd) + parseFloat(budget.reserved_usd) > warningThreshold) {
          context._budgetWarning = true;
        }
      }
    }
  }

  // Halt check — fail-closed (spec §9)
  // Check both task_events (legacy) and halt_signals table (spec-compliant)
  let haltResult;
  try {
    haltResult = await queryFn(
      `SELECT 1 FROM agent_graph.task_events
       WHERE event_type = 'halt_signal' AND processed_at IS NULL
       UNION ALL
       SELECT 1 FROM agent_graph.halt_signals
       WHERE is_active = true
       LIMIT 1`,
      []
    );
  } catch (err) {
    // Fallback: one table may not exist (partial migration)
    if (err.message?.includes('does not exist')) {
      for (const sql of [
        `SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true LIMIT 1`,
        `SELECT 1 FROM agent_graph.task_events WHERE event_type = 'halt_signal' AND processed_at IS NULL LIMIT 1`,
      ]) {
        try { haltResult = await queryFn(sql, []); break; } catch { /* try next */ }
      }
      haltResult = haltResult || { rows: [] };
    } else {
      throw err;
    }
  }

  if (haltResult.rows.length > 0) {
    failedChecks.push('halt_active');
  }

  // Config hash verification
  if (configHash) {
    const configResult = await queryFn(
      `SELECT config_hash FROM agent_graph.agent_configs WHERE id = $1`,
      [agentId]
    );

    if (configResult.rows.length > 0 && configResult.rows[0].config_hash !== configHash) {
      failedChecks.push('config_hash_mismatch');
    }
  }

  // can_assign_to validation (spec §5): agent can only claim tasks assigned to it
  // Exception: state_changed events are routing notifications — the orchestrator
  // must read completed tasks assigned to other agents to make routing decisions.
  // Also check data classification (spec §5)
  if (taskId) {
    const taskResult = await queryFn(
      `SELECT assigned_to, data_classification FROM agent_graph.work_items WHERE id = $1`,
      [taskId]
    );
    const assignedTo = taskResult.rows[0]?.assigned_to;
    if (assignedTo && assignedTo !== agentId && assignedTo !== '*' && action !== 'state_changed') {
      failedChecks.push('can_assign_to_violation');
    }

    // Data classification enforcement: agents can only access INTERNAL and PUBLIC
    // CONFIDENTIAL/RESTRICTED require board approval (escalation)
    const classification = taskResult.rows[0]?.data_classification;
    if (classification && ['CONFIDENTIAL', 'RESTRICTED'].includes(classification)) {
      failedChecks.push(`data_classification_${classification.toLowerCase()}`);
    }
  }

  // Delegation depth check (spec §5, Gap 8)
  // Prevents unbounded task decomposition. Max depth per tier:
  // executor=2, orchestrator=3, architect=4, strategist=5
  if (taskId) {
    const depthResult = await queryFn(
      `SELECT delegation_depth FROM agent_graph.work_items WHERE id = $1`,
      [taskId]
    );
    const depth = depthResult.rows[0]?.delegation_depth;
    if (depth != null) {
      const maxDepth = gates.gates?.delegation_depth?.maxDepth ?? 5;
      if (depth > maxDepth) {
        failedChecks.push('delegation_depth_exceeded');
      }
      context._delegationDepth = depth;
    }
  }

  // Constitutional evaluation (spec §13-14: shadow in Phase 2, active in Phase 3+)
  if (taskId) {
    try {
      const { evaluateConstitutional } = await import('../constitutional-engine.js');
      const constResult = await evaluateConstitutional(taskId);
      if (constResult.blocked) {
        // Active mode: constitutional violations block the task
        failedChecks.push('constitutional_violation');
      } else if (constResult.wouldBlock) {
        // Shadow mode: log only, do not block
        context._constitutionalWarning = constResult.violations;
      }
    } catch (err) {
      // Non-fatal in shadow mode; fail-closed in active mode
      try {
        const { getEnforcementMode } = await import('../constitutional-engine.js');
        const mode = await getEnforcementMode();
        if (mode === 'active') {
          failedChecks.push('constitutional_check_error');
        }
      } catch {
        // Double failure — do not block
      }
    }
  }

  // Graduated escalation check (spec §8)
  // Level 0: normal. Level 1: monitoring only (deferred: increase audit frequency).
  // Level 2: force review. Level 3: block new task claims. Level 4: halt.
  if (agentId && agentId !== 'unknown') {
    try {
      const level = await getEscalationLevel('agent', agentId);
      context._escalationLevel = level;
      if (level >= 4) {
        failedChecks.push('escalation_level_4_halt');
      } else if (level >= 3 && action === 'claim_task') {
        failedChecks.push('escalation_level_3_no_new_claims');
      }
      if (level >= 2) {
        context._forceReview = true;
      }
    } catch (err) {
      // P1: Deny by default. Escalation check failure blocks the task.
      // If the escalation_levels table doesn't exist yet, the error message
      // will indicate a missing relation — log it clearly for debugging.
      log.error(`Escalation check failed for ${agentId} — blocking task (P1): ${err.message}`);
      failedChecks.push('escalation_check_error');
      context._escalationCheckFailed = true;
    }
  }

  // G10: Per-Agent Daily Spend Cap (P2: infrastructure enforces via SQL query)
  // Advisory for cli driver (subscription returns $0). Enforced for metered drivers.
  const g10 = gates.gates?.G10;
  if (g10?.enabled && agentId && agentId !== 'unknown') {
    const dailyCap = g10.default_daily_cap_usd ?? 5.00;
    try {
      const spendResult = await queryFn(
        `SELECT COALESCE(SUM(cost_usd), 0)::float AS daily_spend
         FROM agent_graph.llm_invocations
         WHERE agent_id = $1 AND created_at >= CURRENT_DATE`,
        [agentId]
      );
      const dailySpend = spendResult.rows[0]?.daily_spend ?? 0;
      context._g10DailySpend = dailySpend;
      context._g10DailyCap = dailyCap;

      if (dailySpend >= dailyCap) {
        if (g10.mode === 'block') {
          failedChecks.push('G10_daily_spend_cap_exceeded');
        } else {
          // warn mode: log but allow
          log.warn(`G10: agent ${agentId} daily spend $${dailySpend.toFixed(2)} exceeds cap $${dailyCap.toFixed(2)} (mode=warn, allowing)`);
          context._g10Warning = true;
        }
      }
    } catch (err) {
      // P1: Deny by default. A spend cap that fails open is not a spend cap.
      // If the spend check can't be completed (DB unavailable, table mismatch),
      // block the action — the work item transitions to 'blocked' and retries
      // up to the task-graph retry cap, rather than running with no financial
      // ceiling. Mirrors the escalation_check_error fail-closed convention above.
      log.error(`G10: spend check failed for ${agentId} — blocking action (P1): ${err.message}`);
      failedChecks.push('G10_spend_check_error');
      context._g10CheckFailed = true;
    }
  }

  // G11: Retrospective gate — require retrospective capture before task completion.
  // Only checked on 'complete_task' actions. Config-driven, default disabled.
  // P2: Infrastructure-enforced (DB query), not prompt-level.
  const g11 = gates.gates?.G11;
  if (g11?.enabled && action === 'complete_task') {
    const requiredAgents = g11.params?.requiredAgents || [];
    if (requiredAgents.includes(agentId) || requiredAgents.includes('*')) {
      try {
        const retroResult = await queryFn(
          `SELECT 1 FROM agent_graph.retrospective_log
           WHERE work_item_id = $1 AND agent_id = $2
           LIMIT 1`,
          [taskId, agentId]
        );
        if (retroResult.rows.length === 0) {
          if (g11.params?.mode === 'block') {
            failedChecks.push('G11_retrospective_missing');
          } else {
            context._g11Warning = true;
            log.warn(`G11: agent ${agentId} completing task ${taskId} without retrospective (mode=warn)`);
          }
        }
      } catch (err) {
        // Fail-open: table may not exist yet (pre-migration 047)
        log.warn(`G11: retrospective check failed (fail-open): ${err.message}`);
        context._g11CheckFailed = true;
      }
    }
  }

  const allowed = failedChecks.length === 0;

  return {
    allowed,
    failedChecks,
    reason: allowed ? 'all checks passed' : `Failed: ${failedChecks.join(', ')}`,
    _budgetReserved: context._budgetReserved || 0,
    _campaignId: context._campaignId ?? null,
    _budgetAccountId: context._budgetAccountId ?? null,
    _budgetWarning: context._budgetWarning || false,
    _constitutionalWarning: context._constitutionalWarning || null,
    _escalationLevel: context._escalationLevel ?? 0,
    _escalationCheckFailed: context._escalationCheckFailed || false,
    _forceReview: context._forceReview || false,
    _g10DailySpend: context._g10DailySpend ?? null,
    _g10DailyCap: context._g10DailyCap ?? null,
    _g10Warning: context._g10Warning || false,
    _g10CheckFailed: context._g10CheckFailed || false,
    _g11Warning: context._g11Warning || false,
    _g11CheckFailed: context._g11CheckFailed || false,
  };
}

/**
 * Check a draft against content gates (G2, G3, G5, G6, G7).
 * Called by the Reviewer agent.
 * @param {Object} draft - The draft to check
 * @param {Object|null} voiceProfile - Voice profile for G3 tone matching
 * @param {pg.Client|null} txClient - Optional transaction client for atomic G6 rate-limit check
 * @param {Object|null} senderRegister - Sender formality register for G3 threshold adjustment
 * @param {string} actionType - Action type (e.g. 'email_draft', 'content_post'); gates without this type in their applicableTo are auto-skipped
 */
export async function checkDraftGates(draft, voiceProfile = null, txClient = null, senderRegister = null, actionType = 'email_draft') {
  const q = txClient ? (text, params) => txClient.query(text, params) : query;
  const results = {};

  // Fail-open: gates without applicableTo run for all action types.
  // This is intentional — G1/G4 are checked elsewhere (guardCheck / board_approval)
  // and never reach this function. Any NEW gate added to checkDraftGates MUST
  // include applicableTo in gates.json or it will apply universally.
  const isApplicable = (gateId) => {
    const list = gates.gates[gateId]?.applicableTo;
    return !list || list.includes(actionType);
  };

  // Normalize draft body: action_proposals may store content as body, proposed_text, or proposed_content
  const draftBody = draft.body || draft.proposed_text || draft.proposed_content || '';

  // G2: Legal — commitment/contract language scan
  if (isApplicable('G2')) {
    const g2Patterns = gatePatterns('G2', 'G2_PATTERNS_EXTRA');
    const g2Matches = g2Patterns
      .map(p => draftBody.match(p))
      .filter(Boolean)
      .map(m => m[0]);

    results.G2 = {
      passed: g2Matches.length === 0,
      matches: g2Matches,
    };
  } else {
    results.G2 = { passed: true, skipped: true, reason: `Not applicable for ${actionType}` };
  }

  // G3: Reputational — tone match via pgvector cosine similarity (spec §5, P2)
  // Infrastructure enforces: compute similarity against voice profile embeddings.
  // LLM opinion supplements but cannot override infrastructure score.
  if (isApplicable('G3')) {
    const minScore = gates.gates.G3.params.minScore || 0.80;
    if (voiceProfile && hasCapability('voice/embeddings')) {
      try {
        const { embedText } = getCapability('voice/embeddings');
        const draftEmbedding = await embedText(draftBody);
        const embeddingStr = `[${draftEmbedding.join(',')}]`;

        // Find cosine similarity against sent email corpus
        const simResult = await query(
          `SELECT 1 - (embedding <=> $1::vector) AS similarity
           FROM voice.sent_emails
           WHERE embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector
           LIMIT 10`,
          [embeddingStr]
        );

        if (simResult.rows.length > 0) {
          // Average top-10 similarity as the tone match score
          const avgSim = simResult.rows.reduce((sum, r) => sum + parseFloat(r.similarity), 0) / simResult.rows.length;

          // G3 formality tolerance: widen threshold when sender register differs from Eric's profile.
          // Uses register enum (formal/neutral/casual) to avoid scale mismatch between
          // voiceProfile.formality_score (keyword ratio) and senderRegister.formality (0-1 scale).
          let adjustedMinScore = minScore;
          if (senderRegister?.formality != null) {
            const ericRegister = (voiceProfile?.formality_score ?? 0.35) < 0.3 ? 'casual'
              : (voiceProfile?.formality_score ?? 0.35) > 0.6 ? 'formal' : 'neutral';
            const registerDistance = { casual: 0, neutral: 1, formal: 2 };
            const gap = Math.abs((registerDistance[senderRegister.register] || 0) - (registerDistance[ericRegister] || 0));
            // gap 0 = same register, gap 1 = adjacent, gap 2 = opposite ends
            const adjustment = gap * 0.05; // max 0.10 for casual↔formal
            adjustedMinScore = minScore - adjustment;
          }

          results.G3 = {
            passed: avgSim >= adjustedMinScore,
            score: clampToneScoreForPersistence(avgSim),
            method: 'pgvector_cosine',
            sampleCount: simResult.rows.length,
            ...(adjustedMinScore !== minScore ? { adjustedThreshold: Math.round(adjustedMinScore * 100) / 100, adjustmentReason: 'sender_formality_shift' } : {}),
          };
        } else {
          // No embeddings yet — pass with warning
          results.G3 = { passed: true, score: null, note: 'No embeddings available yet', method: 'skip' };
        }
      } catch (err) {
        // Fail-closed: embedding API unavailable means we can't verify tone match
        results.G3 = { passed: false, score: null, note: `Embedding API error: ${err.message}`, method: 'error' };
      }
    } else {
      results.G3 = { passed: true, score: null, note: 'No voice profile available' };
    }
  } else {
    results.G3 = { passed: true, skipped: true, reason: `Not applicable for ${actionType}` };
  }

  // G5: Reversibility — flag reply-all
  if (isApplicable('G5')) {
    const recipientCount = (draft.to_addresses?.length || 0) + (draft.cc_addresses?.length || 0);
    results.G5 = {
      passed: recipientCount <= gates.gates.G5.params.flagLargeRecipientList,
      recipientCount,
      isReplyAll: recipientCount > 1,
    };
  } else {
    results.G5 = { passed: true, skipped: true, reason: `Not applicable for ${actionType}` };
  }

  // G6: Stakeholder — per-recipient-per-day rate limit (spec §5)
  if (isApplicable('G6')) {
    const maxPerDay = gates.gates.G6.params.maxEmailsPerRecipientPerDay || 3;
    const recipients = [
      ...(draft.to_addresses || []),
      ...(draft.cc_addresses || []),
    ];
    if (recipients.length > 0) {
      try {
        const countResult = await q(
          `SELECT COUNT(*) as cnt FROM agent_graph.action_proposals
           WHERE action_type = 'email_draft'
             AND send_state IN ('delivered', 'reviewed')
             AND created_at >= CURRENT_DATE
             AND to_addresses && $1`,
          [recipients]
        );
        const sentToday = parseInt(countResult.rows[0]?.cnt || '0', 10);
        results.G6 = {
          passed: sentToday < maxPerDay,
          sentToday,
          limit: maxPerDay,
          recipients,
        };
      } catch (err) {
        // Fail-closed: cannot verify rate limit, so block the draft
        results.G6 = { passed: false, sentToday: null, limit: maxPerDay, note: `Rate check error: ${err.message}` };
      }
    } else {
      results.G6 = { passed: true, sentToday: 0, limit: maxPerDay };
    }
  } else {
    results.G6 = { passed: true, skipped: true, reason: `Not applicable for ${actionType}` };
  }

  // G7: Precedent — pricing/timeline/policy commitments
  if (isApplicable('G7')) {
    const g7Patterns = gatePatterns('G7', 'G7_PATTERNS_EXTRA');
    const g7Matches = g7Patterns
      .map(p => draftBody.match(p))
      .filter(Boolean)
      .map(m => m[0]);

    results.G7 = {
      passed: g7Matches.length === 0,
      matches: g7Matches,
    };
  } else {
    results.G7 = { passed: true, skipped: true, reason: `Not applicable for ${actionType}` };
  }

  const allPassed = Object.values(results).every(r => r.passed);

  return { passed: allPassed, gates: results };
}
