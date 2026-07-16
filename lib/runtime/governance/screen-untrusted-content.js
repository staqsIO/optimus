/**
 * Pre-LLM/pre-tool-loop screening for untrusted external content (GH #541).
 *
 * Runner agents (issue-triage, claw-workshop) route attacker-controllable
 * text — GitHub/Linear issue bodies, Linear comments — into an LLM prompt or
 * an agentic tool loop with no screening. This is the missing gate: run the
 * text through G8 (Model Armor, sanitizer.js#checkModelArmor) before it
 * reaches the model, and give each caller a policy on what to do when Model
 * Armor itself can't be reached (failClosed).
 *
 * Callers choose failClosed based on blast radius: issue-triage is a
 * read-only classifier (failClosed: false — allow-on-uncertain, block-on-
 * flag); claw-workshop feeds a tool loop with Write/Bash/network access
 * (failClosed: true — block on flag AND on can't-screen).
 */

import { checkModelArmor, getModelArmorConfig } from './sanitizer.js';
import { recordThreatEvent } from '../escalation-manager.js';

const TOO_SHORT_MIN_LENGTH = 20;

/**
 * Screen a block of untrusted text before it reaches an LLM prompt or tool loop.
 *
 * @param {string} text - Untrusted external content (issue body, comment, etc.)
 * @param {Object} opts
 * @param {string} opts.agentId - Calling agent id, used as threat_memory scope_id
 * @param {boolean} [opts.failClosed=false] - Policy when Model Armor can't be reached
 * @returns {Promise<{decision: 'allow'|'block', screened: boolean, matched?: boolean,
 *   confidence?: string, warn?: boolean, reason: string}>}
 */
export async function screenUntrustedContent(text, { agentId, failClosed = false } = {}) {
  // Model Armor's own floor: too-short text can't be meaningfully screened.
  // This is a benign null case, not an outage — never block on it, even
  // under a fail-closed policy.
  if (!text || text.trim().length < TOO_SHORT_MIN_LENGTH) {
    return { decision: 'allow', screened: false, reason: 'too-short' };
  }

  const armor = await checkModelArmor(text);

  if (armor && armor.matched) {
    const result = {
      decision: 'block',
      screened: true,
      matched: true,
      confidence: armor.confidence,
      reason: 'model-armor-match',
    };
    await recordDecision(result, text, agentId);
    return result;
  }

  if (armor && !armor.matched) {
    return { decision: 'allow', screened: true, matched: false, reason: 'model-armor-clean' };
  }

  // armor === null: genuinely couldn't screen (unconfigured or unreachable).
  const configured = !!getModelArmorConfig().template;
  const reason = configured ? 'model-armor-unavailable' : 'model-armor-unconfigured';

  if (failClosed) {
    const result = { decision: 'block', screened: false, reason };
    await recordDecision(result, text, agentId);
    return result;
  }

  const result = { decision: 'allow', screened: false, warn: true, reason };
  await recordDecision(result, text, agentId);
  return result;
}

/**
 * Record a screening decision to threat_memory. Fail-soft: the table may
 * not exist yet, and a logging failure must never block the caller.
 */
async function recordDecision(result, text, agentId) {
  try {
    await recordThreatEvent({
      sourceType: 'sanitization',
      scopeType: 'agent',
      scopeId: agentId,
      // NOTE: chk_threat_class (sql/001-baseline.sql) has no dedicated value
      // for this case; INJECTION_ATTEMPT is the closest existing class and
      // matches what sanitizer.js's own detectAndRecordThreats() already
      // uses for Model-Armor-driven events.
      threatClass: 'INJECTION_ATTEMPT',
      severity: result.decision === 'block' ? 'HIGH' : 'MEDIUM',
      detail: { reason: result.reason, inputPreview: text.slice(0, 200) },
    });
  } catch {
    // Non-fatal: threat_memory table may not exist yet.
  }
}
