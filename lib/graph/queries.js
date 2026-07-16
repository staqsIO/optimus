// graph/queries.js — Multi-hop Neo4j knowledge graph queries (ADR-019)
// P2: All data from these queries is advisory only — never use for enforcement decisions.
import { runCypher, isGraphAvailable, getOriginOrg } from './client.js';
import { createLogger } from '../logger.js';
const log = createLogger('graph/queries');

/** Coerce a Neo4j Integer | number | null to a plain number. */
function toPlainNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v) || 0;
}

/**
 * Recent `:Meeting` nodes for agent context injection (Plan 041). This is the
 * payoff of making meetings first-class graph nodes — agents can now surface
 * recent meetings in their context (advisory only, P2).
 *
 * Tenancy (fail-closed, ADR-007 §2): only meetings whose origin_org matches the
 * current org token (or legacy NULL org-shared nodes) are returned, mirroring
 * the chat-query-template convention. LIMIT is toInteger()'d because a JS number
 * arrives at Neo4j as a Float otherwise.
 *
 * @param {number} [limit=5]
 * @returns {Promise<Array<{id,title,source,startTime,participantCount}>>}
 */
export async function getRecentMeetings(limit = 5) {
  if (!isGraphAvailable()) return [];
  try {
    const records = await runCypher(
      `MATCH (m:Meeting)
       WHERE m.origin_org = $originOrg OR m.origin_org IS NULL
       OPTIONAL MATCH (:Person)-[:ATTENDED]->(m)
       WITH m, count(*) AS participantCount
       RETURN m.id AS id, m.title AS title, m.source AS source,
              m.start_time AS startTime, participantCount
       ORDER BY coalesce(m.updated_at, m.created_at) DESC
       LIMIT toInteger($limit)`,
      { originOrg: getOriginOrg(), limit },
      { readOnly: true, caller: 'getRecentMeetings' },
    );
    if (!records) return [];
    return records.map((r) => ({
      id: r.get('id'),
      title: r.get('title'),
      source: r.get('source'),
      startTime: r.get('startTime'),
      participantCount: toPlainNumber(r.get('participantCount')),
    }));
  } catch (err) {
    log.warn('getRecentMeetings error:', err.message);
    return [];
  }
}

/**
 * Trace decisions back through outcomes across agent tiers.
 * Multi-hop: Agent → Decision ← DecidingAgent, Agent → TaskOutcome
 *
 * @param {string} agentId - Agent whose decisions to trace
 * @param {number} [days=30] - Lookback window in days
 * @returns {Promise<Array|null>} Decision-outcome chain or null if unavailable
 */
export async function getDecisionOutcomeChain(agentId, days = 30) {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (a:Agent {id: $agentId})-[:PROPOSED_DECISION]->(d:Decision)
       OPTIONAL MATCH (d)<-[:DECIDED_ON]-(decider:Agent)
       OPTIONAL MATCH (a)-[:COMPLETED_TASK]->(t:TaskOutcome)
       WHERE t.created_at > datetime() - duration('P' + toString($days) + 'D')
       WITH d, decider, collect(DISTINCT {task_type: t.task_type, success: t.success, duration_ms: t.duration_ms}) as outcomes
       ORDER BY d.created_at DESC
       LIMIT 20
       RETURN d.type as decision_type, d.recommendation as decision, d.status as verdict,
              decider.id as decided_by, outcomes`,
      { agentId, days: parseInt(days, 10) },
      { readOnly: true }
    );
    return records?.map(r => r.toObject()) || [];
  } catch (err) {
    log.warn('getDecisionOutcomeChain error:', err.message);
    return null;
  }
}

/**
 * Multi-hop delegation effectiveness: which delegation paths produce the best outcomes?
 * Path: Assigner → CAN_DELEGATE_TO → Executor → COMPLETED_TASK → TaskOutcome
 *
 * @param {number} [days=30] - Lookback window in days
 * @returns {Promise<Array|null>} Delegation stats or null if unavailable
 */
export async function getDelegationEffectiveness(days = 30) {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (assigner:Agent)-[:CAN_DELEGATE_TO]->(executor:Agent)-[:COMPLETED_TASK]->(t:TaskOutcome)
       WHERE t.created_at > datetime() - duration('P' + toString($days) + 'D')
       WITH assigner, executor,
            count(t) as total_tasks,
            count(CASE WHEN t.success = true THEN 1 END) as successes,
            avg(t.duration_ms) as avg_duration
       RETURN assigner.id as assigner, executor.id as executor,
              total_tasks, successes,
              CASE WHEN total_tasks > 0 THEN toFloat(successes) / total_tasks ELSE 0 END as success_rate,
              avg_duration
       ORDER BY total_tasks DESC`,
      { days: parseInt(days, 10) },
      { readOnly: true }
    );
    return records?.map(r => r.toObject()) || [];
  } catch (err) {
    log.warn('getDelegationEffectiveness error:', err.message);
    return null;
  }
}

/**
 * Capability utilization: which capabilities does this agent use vs what it has?
 * Multi-hop: Agent → HAS_CAPABILITY → Capability, Agent → COMPLETED_TASK → TaskOutcome
 *
 * @param {string} agentId - Agent to analyze
 * @param {number} [days=30] - Lookback window in days
 * @returns {Promise<Object|null>} Utilization data or null if unavailable
 */
export async function getAgentCapabilityUtilization(agentId, days = 30) {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (a:Agent {id: $agentId})-[:HAS_CAPABILITY]->(c:Capability)
       OPTIONAL MATCH (a)-[:COMPLETED_TASK]->(t:TaskOutcome)
       WHERE t.created_at > datetime() - duration('P' + toString($days) + 'D')
       WITH a, collect(DISTINCT c.name) as all_capabilities,
            collect(DISTINCT t.task_type) as used_task_types,
            count(t) as total_tasks
       RETURN all_capabilities, used_task_types, total_tasks,
              size([cap IN all_capabilities WHERE cap IN used_task_types]) as utilized_count,
              size(all_capabilities) as total_capabilities`,
      { agentId, days: parseInt(days, 10) },
      { readOnly: true }
    );
    return records?.[0]?.toObject() || null;
  } catch (err) {
    log.warn('getAgentCapabilityUtilization error:', err.message);
    return null;
  }
}

/**
 * Find tasks with similar patterns to learn from.
 * Multi-hop: Agent → COMPLETED_TASK → TaskOutcome (filtered by type)
 *
 * @param {string} taskType - Task type to find similar patterns for
 * @param {number} [days=30] - Lookback window in days
 * @returns {Promise<Array|null>} Similar outcome patterns or null if unavailable
 */
export async function getSimilarOutcomePatterns(taskType, days = 30) {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (a:Agent)-[:COMPLETED_TASK]->(t:TaskOutcome)
       WHERE t.task_type = $taskType AND t.created_at > datetime() - duration('P' + toString($days) + 'D')
       WITH a, t,
            CASE WHEN t.success THEN 'success' ELSE 'failure' END as outcome
       RETURN a.id as agent, outcome, t.duration_ms as duration,
              count(*) as occurrences,
              collect(t.task_type)[0..5] as sample_types
       ORDER BY occurrences DESC
       LIMIT 10`,
      { taskType, days: parseInt(days, 10) },
      { readOnly: true }
    );
    return records?.map(r => r.toObject()) || [];
  } catch (err) {
    log.warn('getSimilarOutcomePatterns error:', err.message);
    return null;
  }
}

/**
 * Full multi-hop organizational topology visualization.
 * Traverses: Agent → CAN_DELEGATE_TO → Agent, Agent → HAS_CAPABILITY → Capability,
 *            Agent → COMPLETED_TASK → TaskOutcome
 *
 * @returns {Promise<Array|null>} Org topology or null if unavailable
 */
export async function getOrganizationalTopology() {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (a:Agent)
       OPTIONAL MATCH (a)-[:CAN_DELEGATE_TO]->(delegate:Agent)
       OPTIONAL MATCH (a)-[:HAS_CAPABILITY]->(c:Capability)
       OPTIONAL MATCH (a)-[:COMPLETED_TASK]->(t:TaskOutcome)
       WHERE t.created_at > datetime() - duration({days: 7})
       WITH a,
            collect(DISTINCT delegate.id) as delegates,
            collect(DISTINCT c.name) as capabilities,
            count(t) as recent_tasks,
            count(CASE WHEN t.success THEN 1 END) as recent_successes
       RETURN a.id as agent, a.tier as tier, a.model as model,
              delegates, capabilities, recent_tasks, recent_successes
       ORDER BY a.tier`,
      {},
      { readOnly: true }
    );
    return records?.map(r => r.toObject()) || [];
  } catch (err) {
    log.warn('getOrganizationalTopology error:', err.message);
    return null;
  }
}

/**
 * Format graph learning data into a compact prompt section.
 * Enforces a hard cap of 500 characters to stay within context budget.
 *
 * // P2: Neo4j data is advisory only — never use for enforcement decisions
 *
 * @param {Object} opts
 * @param {Array|null} opts.decisionChains - From getDecisionOutcomeChain
 * @param {Array|null} opts.delegationEffectiveness - From getDelegationEffectiveness
 * @param {Array|null} opts.recentOutcomes - From Postgres reflection context
 * @returns {string|null} Formatted prompt section or null if no data
 */
export function formatLearningContext({ decisionChains, delegationEffectiveness, recentOutcomes } = {}) {
  const parts = [];

  if (decisionChains?.length > 0) {
    const matched = decisionChains.filter(d => d.verdict === 'approved').length;
    parts.push(`Decision accuracy: ${matched}/${decisionChains.length} decisions matched board verdicts.`);
  }

  if (delegationEffectiveness?.length > 0) {
    const top = delegationEffectiveness.slice(0, 3).map(d => {
      const rate = typeof d.success_rate === 'number' ? (d.success_rate * 100).toFixed(0) : '?';
      return `${d.assigner}->${d.executor}: ${rate}% (${d.total_tasks} tasks)`;
    });
    parts.push(`Delegation: ${top.join(', ')}.`);
  }

  if (recentOutcomes?.length > 0) {
    const completed = recentOutcomes.filter(o => o.status === 'completed').length;
    const total = recentOutcomes.length;
    const pct = total > 0 ? Math.round(100 * completed / total) : 0;
    parts.push(`Recent: ${total} tasks, ${pct}% success.`);
  }

  if (parts.length === 0) return null;

  // Hard cap: 500 chars for context budget
  const full = `## Historical Learning Context\n${parts.join('\n')}`;
  if (full.length <= 500) return full;
  const cutPoint = full.lastIndexOf('\n', 497);
  return (cutPoint > 0 ? full.slice(0, cutPoint) : full.slice(0, 497)) + '...';
}

/**
 * Get task-relevant learning context for prompt injection.
 * Scoped to the requesting agent's own patterns only (P1: no cross-agent leakage).
 * sample_size >= 5 gate before trusting patterns.
 *
 * Fallback chain (strict — use first available, Liotta):
 * 1. learned_patterns for this agent, sample_size >= 5
 * 2. Neo4j getSimilarOutcomePatterns(taskType)
 * 3. null (caller falls back to existing _reflectionContext.learningContext)
 *
 * @param {string} agentId - The requesting agent
 * @param {string} taskType - Current task type for filtering
 * @param {Object} [metadata] - Work item metadata for additional context
 * @returns {Promise<Object|null>} Task-relevant context or null
 */
export async function getTaskRelevantContext(agentId, taskType, metadata) {
  const start = performance.now();
  let fallbackTier = 'none';
  let result = null;

  try {
    // Tier 1: Agent-specific patterns from learned_patterns (Postgres)
    // Strictly filtered by agentId — no cross-agent data (P1, Linus blocker)
    const { query: pgQuery } = await import('../db.js');
    const patternResult = await pgQuery(
      `SELECT pattern_type, metric_value, sample_size, confidence, metadata
       FROM agent_graph.learned_patterns
       WHERE agent_id = $1 AND sample_size >= 5
       ORDER BY created_at DESC
       LIMIT 10`,
      [agentId]
    );

    // For orchestrator: also get delegation patterns where this agent is the assigner
    let delegationPatterns = { rows: [] };
    if (agentId === 'orchestrator') {
      delegationPatterns = await pgQuery(
        `SELECT agent_id, metric_value, sample_size, metadata
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'delegation_path'
           AND agent_id LIKE $1
           AND sample_size >= 5
         ORDER BY metric_value DESC
         LIMIT 5`,
        [`${agentId}\u2192%`]
      );
    }

    // Shared patterns: delegation paths where this agent is involved (either side)
    // This is P1-safe because the agent is referenced in the data
    let sharedDelegation = { rows: [] };
    if (agentId !== 'orchestrator') {
      sharedDelegation = await pgQuery(
        `SELECT agent_id, metric_value, sample_size, metadata
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'delegation_path'
           AND (agent_id LIKE $1 OR agent_id LIKE $2)
           AND sample_size >= 5
         ORDER BY metric_value DESC
         LIMIT 3`,
        [`%\u2192${agentId}`, `${agentId}\u2192%`]
      );
    }

    // Failure patterns for this agent
    const failurePatterns = await pgQuery(
      `SELECT metric_value, sample_size, metadata
       FROM agent_graph.learned_patterns
       WHERE agent_id = $1 AND pattern_type = 'failure_mode' AND sample_size >= 3
       ORDER BY metric_value DESC
       LIMIT 3`,
      [agentId]
    );

    if (patternResult.rows.length > 0) {
      fallbackTier = 'specific_pattern';
      result = {
        agentPatterns: patternResult.rows,
        delegationPatterns: delegationPatterns.rows,
        sharedDelegation: sharedDelegation.rows,
        failurePatterns: failurePatterns.rows,
        source: 'postgres',
      };
    } else {
      // Tier 2: Neo4j similar outcome patterns (graceful degradation)
      const similarPatterns = await getSimilarOutcomePatterns(taskType);
      if (similarPatterns?.length > 0) {
        fallbackTier = 'neo4j_similar';
        result = {
          similarOutcomes: similarPatterns.slice(0, 5),
          source: 'neo4j',
        };
      }
      // Tier 3: null — caller uses existing _reflectionContext.learningContext
    }
  } catch (err) {
    log.warn('getTaskRelevantContext error:', err.message);
  }

  const durationMs = Math.round(performance.now() - start);
  log.info(JSON.stringify({
    event: 'learning_context_resolved',
    tier: fallbackTier,
    agent: agentId,
    task_type: taskType,
    duration_ms: durationMs,
    pattern_count: result?.agentPatterns?.length || result?.similarOutcomes?.length || 0,
  }));
  return result;
}

// Tier-aware context budget caps (Improvement 1)
const TIER_CAPS = {
  haiku: 500,
  sonnet: 1000,
  opus: 2000,
};

/**
 * Format task-relevant context into a prompt section.
 * All text is reconstructed from numeric/enum fields only (Linus: prompt injection safety).
 * No free-text from stored data enters the prompt.
 * Tier-aware cap: haiku=500, sonnet=1000, opus=2000. Default=500.
 *
 * @param {Object|null} taskCtx - From getTaskRelevantContext()
 * @param {string} [agentTier] - Agent tier: 'haiku', 'sonnet', 'opus'
 * @returns {string|null} Formatted prompt section or null
 */
export function formatTaskContext(taskCtx, agentTier) {
  if (!taskCtx) return null;

  const parts = [];

  if (taskCtx.agentPatterns?.length > 0) {
    for (const p of taskCtx.agentPatterns) {
      const val = parseFloat(p.metric_value);
      const n = parseInt(p.sample_size, 10);
      switch (p.pattern_type) {
        case 'success_rate':
          parts.push(`Your success rate: ${(val * 100).toFixed(0)}% (n=${n}).`);
          break;
        case 'cost_efficiency':
          parts.push(`Your cost: $${val.toFixed(4)}/task (n=${n}).`);
          break;
        case 'duration_trend':
          parts.push(`Your median duration: ${(val / 1000).toFixed(1)}s (n=${n}).`);
          break;
      }
    }
  }

  if (taskCtx.delegationPatterns?.length > 0) {
    for (const d of taskCtx.delegationPatterns) {
      const meta = d.metadata || {};
      const val = parseFloat(d.metric_value);
      const n = parseInt(d.sample_size, 10);
      parts.push(`Delegation ${meta.assigner || '?'}\u2192${meta.executor || '?'}: ${(val * 100).toFixed(0)}% (n=${n}).`);
    }
  }

  if (taskCtx.failurePatterns?.length > 0) {
    for (const f of taskCtx.failurePatterns) {
      const meta = f.metadata || {};
      const count = parseInt(f.metric_value, 10);
      parts.push(`Watch: ${count} ${meta.error_category || 'unknown'} failure(s) recently.`);
    }
  }

  if (taskCtx.similarOutcomes?.length > 0) {
    const successes = taskCtx.similarOutcomes.filter(o => o.outcome === 'success').length;
    const total = taskCtx.similarOutcomes.length;
    parts.push(`Similar tasks: ${successes}/${total} succeeded recently.`);
  }

  if (taskCtx.sharedDelegation?.length > 0) {
    for (const d of taskCtx.sharedDelegation) {
      const meta = d.metadata || {};
      const val = parseFloat(d.metric_value);
      const n = parseInt(d.sample_size, 10);
      parts.push(`Shared delegation ${meta.assigner || '?'}\u2192${meta.executor || '?'}: ${(val * 100).toFixed(0)}% (n=${n}).`);
    }
  }

  if (parts.length === 0) return null;

  const cap = TIER_CAPS[agentTier] || 500;
  const full = `## Task-Relevant Learning\n${parts.join('\n')}`;
  if (full.length <= cap) return full;
  // Slice at newline boundary (Linus: don't cut mid-word)
  const cutPoint = full.lastIndexOf('\n', cap - 3);
  return (cutPoint > 0 ? full.slice(0, cutPoint) : full.slice(0, cap - 3)) + '...';
}
