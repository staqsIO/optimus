// ============================================================
// G8 production preflight — Model Armor (prompt-injection blocking)
// Infrastructure-enforced (P2), deny-by-default (P1).
// ============================================================
//
// Model Armor defaults to mode='warn' + template=null (see getModelArmorConfig
// in sanitizer.js). In that default/unset configuration the block-mode body
// screen in context-loader.js never runs and the only always-on injection
// defense is the regex sanitize() scrub — detection is log-only, or absent
// entirely when no template is set. Given the Lethal Trifecta present here
// (private inbox data + autonomous outbound + untrusted email/Slack/web
// content), a mis-provisioned PRODUCTION deploy would silently ship with no
// infrastructural injection *block*, and nobody would notice.
//
// This preflight is the infrastructure check that makes that gap impossible to
// miss: when agents are enabled in production, it asserts that the blocking
// path is actually armed (MODEL_ARMOR_MODE=block AND MODEL_ARMOR_TEMPLATE set)
// and fails fast (throws) otherwise. It is deliberately scoped so that dev,
// test, and non-agent processes are never affected — the gate keys off the
// production signal ONLY.
//
// Scope note: this checks *configuration presence* (is blocking armed?). It is
// complementary to — and deliberately does NOT duplicate — OPT-106's separate
// "fail-closed on Model Armor API errors" work, which handles the runtime path.

import { getModelArmorConfig } from './sanitizer.js';

/**
 * Assert that G8 prompt-injection blocking is armed before agents run in
 * production. Throws (fail-fast) when the block path is not fully configured.
 *
 * Only fires when BOTH conditions hold:
 *   - agents will run in this process (`agentsEnabled` is truthy), AND
 *   - the process is running in production (`nodeEnv === 'production'`).
 *
 * In every other case (dev, test, ingestion/api-only processes) it is a no-op
 * and returns a `{ ok: true, skipped }` descriptor.
 *
 * @param {object}  opts
 * @param {boolean} opts.agentsEnabled - whether this process will run agent loops
 * @param {string}  [opts.nodeEnv]     - production signal (defaults to process.env.NODE_ENV)
 * @returns {{ ok: true, skipped?: string, mode?: string }}
 * @throws  {Error} when production + agents enabled + blocking not fully armed
 */
export function assertModelArmorProductionReady({
  agentsEnabled,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  // Production signal only — dev/test/CI boot is never gated (P6: don't break
  // the humans running the system locally).
  if (nodeEnv !== 'production') {
    return { ok: true, skipped: 'not-production' };
  }
  // Processes that don't run agents (api-only, ingestion-only) don't touch the
  // Lethal Trifecta path, so the block requirement doesn't apply to them.
  if (!agentsEnabled) {
    return { ok: true, skipped: 'agents-disabled' };
  }

  // Read env at call time (dotenv-load ordering) via the same accessor the
  // runtime block-mode screen uses — a single source of truth for what "armed"
  // means.
  const { mode, template } = getModelArmorConfig();
  const problems = [];
  if (mode !== 'block') {
    problems.push(`MODEL_ARMOR_MODE is '${mode}' (production requires 'block')`);
  }
  if (!template) {
    problems.push('MODEL_ARMOR_TEMPLATE is unset (production requires a template)');
  }

  if (problems.length > 0) {
    throw new Error(
      '[preflight:G8] Refusing to start agents in production: prompt-injection ' +
        'blocking (Model Armor) is NOT armed — ' +
        problems.join('; ') +
        '. G8 would fail open against untrusted inbound content (Lethal Trifecta). ' +
        'Set MODEL_ARMOR_MODE=block and MODEL_ARMOR_TEMPLATE=<template path> ' +
        '(see .env.example), or run this process with agents disabled.'
    );
  }

  return { ok: true, mode };
}
