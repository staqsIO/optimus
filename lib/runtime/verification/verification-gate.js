/**
 * Verification gate — the pure decision logic for the verification spine, kept
 * OUT of the orchestrator router and the agent-loop tick so it is unit testable
 * in isolation (no claim/JWT/DB setup).
 *
 * Dispatch model (orchestrator-mediated child tree, mirroring responder→reviewer):
 *   1. An implementer completes a work item that carries Factory scenarios.
 *   2. The orchestrator creates a `tester` CHILD to verify it.
 *   3. The tester completes its child, stamping the verdict into the child's
 *      metadata; on fail (under budget) it has already incremented the target's
 *      fix_attempts and stamped last_failure_mode.
 *   4. The orchestrator routes: fail+budget → a fix CHILD back to the implementer;
 *      pass or budget-exhausted → terminal.
 *
 * The whole spine is gated behind VERIFICATION_SPINE_ENABLED so it is a no-op on
 * a live system until explicitly enabled (mirrors SIGNAL_DETECTOR_ENABLED).
 */

export const MAX_FIX_ATTEMPTS = 3;

export function isVerificationSpineEnabled() {
  return process.env.VERIFICATION_SPINE_ENABLED === 'true';
}

/**
 * Agents whose completed work should be verified. Keeps the spine focused (code
 * tasks) instead of verifying every email-pipeline draft. Configurable.
 */
export function verifyAgents() {
  return (process.env.VERIFY_AGENTS || 'executor-coder,executor-redesign')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Should the lazy Scenario Factory run for this work item at claim time?
 * Only for verify-eligible implementer work that doesn't already have scenarios
 * and isn't itself a verification fix (fixes re-verify the original target).
 */
export function shouldGenerateScenarios(workItem, assignedAgentId) {
  if (!isVerificationSpineEnabled()) return false;
  if (!workItem) return false;
  if (!['task', 'subtask'].includes(workItem.type)) return false;
  if (workItem.metadata?.is_verification_fix) return false;
  if (workItem.metadata?.verify_target_id) return false;
  if (hasFactoryScenarios(workItem)) return false;
  return verifyAgents().includes(assignedAgentId);
}

/**
 * Does this work item carry Scenario-Factory acceptance scenarios? Reads the
 * RLS-safe visible mirror on work_items.acceptance_criteria (never the withheld
 * table), so it is correct under any agent identity.
 */
export function hasFactoryScenarios(workItem) {
  const ac = workItem?.acceptance_criteria;
  return !!(
    ac &&
    ac.generated_by === 'scenario-factory' &&
    Array.isArray(ac.scenarios) &&
    ac.scenarios.length > 0
  );
}

/**
 * Decide what the orchestrator should do when `completingAgent` completes
 * `completedItem`. Pure — reads only the completed item + the completing agent.
 * The tester stamps its routing facts into its own (child) metadata, so the
 * tester branch needs no DB query.
 *
 * @returns {{ action: 'verify'|'refix'|'terminal'|'none', targetId?: string,
 *             implementer?: string, failureMode?: string|null, reason?: string }}
 */
export function planVerificationRouting({ completedItem, completingAgent, flagEnabled = isVerificationSpineEnabled() }) {
  if (!flagEnabled || !completedItem) return { action: 'none' };
  const meta = completedItem.metadata || {};

  // Case A — the tester just finished a verification child.
  if (completingAgent === 'tester') {
    const verdict = meta.verification_verdict;
    const targetId = meta.verify_target_id;
    const implementer = meta.verify_implementer;
    const attemptsAfter = meta.fix_attempts_after ?? 0;
    if (verdict === 'fail' && targetId && implementer && attemptsAfter <= MAX_FIX_ATTEMPTS) {
      return {
        action: 'refix',
        targetId,
        implementer,
        failureMode: meta.last_failure_mode ?? null,
        reason: `Verification failed (attempt ${attemptsAfter}/${MAX_FIX_ATTEMPTS}) → re-queue fix to ${implementer}`,
      };
    }
    return {
      action: 'terminal',
      reason: verdict === 'pass'
        ? 'Verification passed — terminal'
        : `Verification failed terminally after ${MAX_FIX_ATTEMPTS} attempts — board review`,
    };
  }

  // Case B — an implementer completed verify-eligible work (either an original
  // item with scenarios, or a fix child that points at a target to re-verify).
  const targetId = hasFactoryScenarios(completedItem)
    ? completedItem.id
    : (meta.is_verification_fix ? meta.verify_target_id : null);
  if (targetId) {
    return {
      action: 'verify',
      targetId,
      implementer: meta.is_verification_fix ? (meta.verify_implementer || completingAgent) : completingAgent,
      reason: `Routing to tester to verify ${targetId}`,
    };
  }

  return { action: 'none' };
}

/**
 * Decide how a claimed work item that is a verification FIX should be handled
 * before the implementer runs.
 *
 *   - A fix child with no last_failure_mode must NOT be run blind (it would
 *     "pass on luck"): abort to `failed`. (Linus blocker.)
 *   - Otherwise return the fix instruction to inject into the implementer's
 *     prompt (null when this isn't a fix).
 *
 * @returns {{ abort: 'failed'|null, fixInstruction: string|null }}
 */
export function resolveReentry(workItem) {
  const meta = workItem?.metadata || {};
  const isFix = !!meta.is_verification_fix;
  const failureMode = meta.last_failure_mode ?? null;
  if (isFix && !failureMode) {
    return { abort: 'failed', fixInstruction: null };
  }
  return { abort: null, fixInstruction: isFix ? failureMode : null };
}
