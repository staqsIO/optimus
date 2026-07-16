import { spawnCLI } from '../../lib/runtime/agents/spawn-cli.js';
import { createChildLogger } from '../../lib/logger.js';
import { MAX_FIX_ATTEMPTS } from '../../lib/runtime/verification/verification-gate.js';

const log = createChildLogger({ agent: 'tester' });

/**
 * Tester handler — Phase 1 of the verification spine.
 *
 * Dispatched (orchestrator-mediated) as a verification CHILD whose metadata
 * carries verify_target_id (the implementer's item to verify) + verify_implementer.
 * It verifies the target against EVERY acceptance scenario — including the
 * WITHHELD edge cases the implementer never saw — then COMPLETES its child,
 * stamping the verdict + routing facts into the child's metadata. The
 * orchestrator reads those and routes a fix back on failure (mirrors how the
 * responder→reviewer flow works). The tester does NOT self-route.
 *
 * Secrecy: withheld scenarios are read through agent.scopedQuery (app.agent_id=
 * 'tester'); the FORCE-RLS policy hides them from every other agent identity.
 * fix_attempts is SEPARATE from retry_count so infra retries and verification
 * failures never share a budget.
 *
 * Kept separate from index.js (which constructs the AgentLoop) so it is unit
 * testable without importing the full agent-loop dependency chain.
 */

/**
 * Extract the trailing JSON verdict object from a CLI transcript. The CLI may
 * emit prose before the JSON; take a fenced block or the outermost trailing
 * {...} (brace-matched — lastIndexOf('{') would grab a nested brace).
 */
export function parseVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  const end = text.lastIndexOf('}');
  if (end !== -1) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') {
        depth--;
        if (depth === 0) { candidates.push(text.slice(i, end + 1)); break; }
      }
    }
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && (parsed.verdict === 'pass' || parsed.verdict === 'fail')) return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Merge keys into a work item's metadata (so the orchestrator can route on them). */
async function stampMetadata(q, workItemId, patch) {
  await q(
    `UPDATE agent_graph.work_items
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE id = $1`,
    [workItemId, JSON.stringify(patch)]
  );
}

export async function testerHandler(task, context, agent) {
  const childId = task.work_item_id; // the verification child the tester owns
  const q = agent.scopedQuery || agent.query;

  // Resolve the verification target from the child's metadata (fallback: verify
  // self, for direct invocation / tests where they coincide).
  const childRes = await q(`SELECT metadata FROM agent_graph.work_items WHERE id = $1`, [childId]);
  const childMeta = childRes.rows[0]?.metadata || {};
  const targetId = childMeta.verify_target_id || childId;

  const tRes = await q(
    `SELECT title, description, assigned_to, fix_attempts, metadata
       FROM agent_graph.work_items WHERE id = $1`,
    [targetId]
  );
  const target = tRes.rows[0];
  if (!target) return { success: false, reason: `verify target ${targetId} not found` };
  const fixAttempts = target.fix_attempts ?? 0;
  const implementer = childMeta.verify_implementer || target.assigned_to || null;

  // Load ALL scenarios incl. withheld (visible only because q runs as tester).
  const scenRes = await q(
    `SELECT scenario, withheld, category
       FROM agent_graph.work_item_scenarios
      WHERE work_item_id = $1
      ORDER BY withheld ASC`,
    [targetId]
  );
  const scenarios = scenRes.rows;
  if (scenarios.length === 0) {
    log.warn(`[tester] target ${targetId} has no scenarios — passing through`);
    await stampMetadata(q, childId, { verification_verdict: 'pass', verify_target_id: targetId });
    return { success: true, reason: 'No scenarios to verify', costUsd: 0 };
  }

  // Verify via a read-only CLI session against the target's artifact.
  const scenarioList = scenarios
    .map((r, i) => `${i + 1}. GIVEN ${r.scenario.given}\n   WHEN ${r.scenario.when}\n   THEN ${r.scenario.then}`)
    .join('\n');
  const workDir = target.metadata?.worktree_path || process.cwd();
  const prompt =
    `You are verifying completed work for: ${target.title}\n` +
    (target.description ? `Task: ${target.description}\n` : '') +
    `\nCheck the work against EACH scenario below as an observable outcome. ` +
    `Inspect the actual artifacts (files, output) to decide — do not assume.\n\n` +
    `Scenarios:\n${scenarioList}\n\n` +
    `Respond with ONLY a final JSON object, no other trailing text:\n` +
    `{"verdict":"pass"|"fail","failure_mode":"<if fail: the single most important broken scenario and how>",` +
    `"scenario_results":[{"n":1,"pass":true}]}`;

  const cli = await spawnCLI({
    backend: 'claude',
    prompt,
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Bash'], // read-only: the tester inspects, never fixes
    maxTurns: 15,
    maxBudgetUsd: 1.0,
    timeoutMs: 5 * 60 * 1000,
    workDir,
    label: `verify:${targetId}`,
    agentTag: 'tester',
  });

  let verdict = 'fail';
  let failureMode = 'Tester could not produce a verdict';
  let scenarioResults = null;
  if (cli.isError) {
    failureMode = `Verification CLI error: ${cli.error || 'unknown'}`;
  } else {
    const parsed = parseVerdict(cli.result);
    if (parsed) {
      verdict = parsed.verdict === 'pass' ? 'pass' : 'fail';
      failureMode = parsed.failure_mode || (verdict === 'fail' ? 'Unspecified verification failure' : null);
      scenarioResults = parsed.scenario_results || null;
    }
  }
  const costUsd = cli.costUsd || 0;

  // Record the verdict against the TARGET. UNIQUE(work_item_id, attempt) +
  // ON CONFLICT guards against a duplicate verdict for the same attempt.
  await q(
    `INSERT INTO agent_graph.verification_verdicts
       (work_item_id, verdict, failure_mode, scenario_results, attempt, tester_agent, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (work_item_id, attempt) DO NOTHING`,
    [
      targetId,
      verdict,
      failureMode,
      scenarioResults ? JSON.stringify(scenarioResults) : null,
      fixAttempts,
      agent.agentId || 'tester',
      costUsd,
    ]
  );

  if (verdict === 'pass') {
    log.info(`[tester] target ${targetId} PASS (${scenarios.length} scenarios)`);
    await stampMetadata(q, childId, { verification_verdict: 'pass', verify_target_id: targetId });
    return { success: true, reason: `Verified: ${scenarios.length} scenarios passed`, costUsd };
  }

  // FAIL — bounded failure-feedback loop. Stamp the TARGET (the thing being
  // built) so fix_attempts/last_failure_mode persist across the implementer↔
  // tester cycle, then stamp the CHILD so the orchestrator can route.
  if (fixAttempts < MAX_FIX_ATTEMPTS) {
    await q(
      `UPDATE agent_graph.work_items
          SET fix_attempts = fix_attempts + 1,
              metadata = jsonb_set(COALESCE(metadata, '{}'), '{last_failure_mode}', $2::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [targetId, JSON.stringify(failureMode || 'verification failed')]
    );
    await stampMetadata(q, childId, {
      verification_verdict: 'fail',
      verify_target_id: targetId,
      verify_implementer: implementer,
      fix_attempts_after: fixAttempts + 1,
      last_failure_mode: failureMode || 'verification failed',
    });
    log.info(`[tester] target ${targetId} FAIL (fix ${fixAttempts + 1}/${MAX_FIX_ATTEMPTS}) → implementer ${implementer}`);
    return { success: true, reason: `Verification failed (fix ${fixAttempts + 1}/${MAX_FIX_ATTEMPTS}): ${failureMode}`, costUsd };
  }

  // Budget exhausted — terminal failure; the orchestrator routes to board.
  await stampMetadata(q, childId, {
    verification_verdict: 'fail',
    verify_target_id: targetId,
    fix_attempts_after: fixAttempts,
  });
  log.warn(`[tester] target ${targetId} FAIL after ${MAX_FIX_ATTEMPTS} fix attempts — terminal`);
  return { success: true, reason: `Verification failed after ${MAX_FIX_ATTEMPTS} fix attempts: ${failureMode}`, costUsd };
}
