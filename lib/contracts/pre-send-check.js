/**
 * Pre-send governance scan for contracts — G2 (Legal / commitment) + G7
 * (Precedent) gates run in a single LLM pass before the operator clicks
 * Send for Signature.
 *
 * This is NOT blocking. Findings surface in the UI so the operator can
 * decide whether to send as-is or go back and edit. The agent-runtime
 * guardCheck() infrastructure in lib/runtime/guard-check.js is shaped
 * around agent-initiated actions with JWT scoping and task-graph state
 * transitions — wrong shape for a human-triggered send, so we run our
 * own focused scan instead.
 *
 * G2 (Legal): unusual commitments — open liability, broad indemnification,
 * exclusivity, unusual payment terms or jurisdiction, missing termination
 * clauses, anything that exceeds what the template normally stipulates.
 *
 * G7 (Precedent): material differences from prior contracts with this
 * counterparty — pricing drift, timeline changes, scope expansion beyond
 * what they've historically agreed to. The most recent 3 prior contracts
 * are passed as context; older ones are ignored to keep cost bounded.
 */

import { query } from '../db.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'contracts/pre-send-check' });

/**
 * @typedef {Object} Finding
 * @property {'G2'|'G7'} gate
 * @property {'info'|'warn'|'block'} severity
 * @property {string} title          short label (<=60 chars)
 * @property {string} excerpt        the clause being flagged, truncated to ~200 chars
 * @property {string} reason         why it's flagged, one sentence
 */

/**
 * @typedef {Object} PreSendResult
 * @property {Finding[]} findings
 * @property {number} costUsd
 * @property {string} model
 * @property {boolean} ragSkipped    true if prior-contract context was empty
 * @property {boolean} [parseError]  true if the model response could not be parsed —
 *                                   the scan did NOT effectively run; callers must
 *                                   fail closed rather than treat findings:[] as clean
 * @property {string}  [parseErrorMsg] the JSON.parse error message when parseError is true
 */

const SYSTEM_PROMPT = `You review outbound contracts on behalf of UMB Advisors' operations board. You do NOT block anything — the operator sends or doesn't. Your job is to surface two kinds of flags so they can make an informed choice.

GATE G2 — Legal / commitment: flag unusual language that commits UMB to something risky or atypical. Look for: unlimited liability, broad indemnification, exclusivity, jurisdiction that isn't Delaware/New York, missing termination clause, auto-renewal without opt-out, intellectual-property assignment beyond work product, warranties UMB can't keep.

GATE G7 — Precedent: flag material differences from the prior contracts provided (if any). Compare pricing, timeline, deliverables, retainer hours, termination terms. A 10% pricing delta or a different engagement length is worth flagging. Tiny wording drift is not.

Severity:
  info  — noteworthy, standard ops review is fine
  warn  — the operator should look at this before sending
  block — you believe the contract should not go out as-is

Return strict JSON only. No prose. No code fences. Schema:
{
  "findings": [
    { "gate": "G2" | "G7", "severity": "info" | "warn" | "block",
      "title": "short label, under 60 chars",
      "excerpt": "the exact phrase from the body, <=200 chars",
      "reason": "one sentence explaining the concern" }
  ]
}

If nothing is concerning, return { "findings": [] }. Don't invent findings to seem thorough.`;

/**
 * @param {Object} opts
 * @param {string} opts.draftId
 * @returns {Promise<PreSendResult>}
 */
export async function preSendCheck({ draftId }) {
  // Load the contract + its counterparty + up to 3 prior contracts with
  // that counterparty for G7 comparison.
  const draft = await query(
    `SELECT d.id, d.title, d.body, d.template_id, d.counterparty_id,
            cp.name AS counterparty_name
       FROM content.drafts d
       LEFT JOIN content.counterparties cp ON cp.id = d.counterparty_id
      WHERE d.id = $1 AND d.content_type = 'contract'`,
    [draftId]
  );
  if (!draft.rows[0]) {
    throw new Error(`Contract ${draftId} not found`);
  }
  const row = draft.rows[0];

  let priorContracts = [];
  let ragSkipped = true;
  if (row.counterparty_id) {
    const prior = await query(
      `SELECT id, title, body, created_at, template_id
         FROM content.drafts
        WHERE counterparty_id = $1
          AND content_type = 'contract'
          AND id != $2
        ORDER BY created_at DESC
        LIMIT 3`,
      [row.counterparty_id, draftId]
    );
    priorContracts = prior.rows;
    ragSkipped = priorContracts.length === 0;
  }

  // Build the user message. Cap prior contract bodies at 4KB each to keep
  // total input bounded; the scan doesn't need to read every clause, just
  // the headline terms.
  const priorSection = priorContracts.length
    ? priorContracts.map((p, i) =>
        `### Prior contract ${i + 1} — ${p.title} (${new Date(p.created_at).toISOString().slice(0,10)})\n${p.body.slice(0, 4000)}`
      ).join('\n\n---\n\n')
    : '(no prior contracts with this counterparty — skip G7 precedent checks)';

  const userPrompt = `CONTRACT UNDER REVIEW
Title: ${row.title}
${row.counterparty_name ? `Counterparty: ${row.counterparty_name}\n` : ''}Template: ${row.template_id || 'unknown'}

BODY:
\`\`\`
${row.body}
\`\`\`

PRIOR CONTRACTS WITH THIS COUNTERPARTY (for G7 precedent):
${priorSection}

Return JSON findings.`;

  const { createLLMClient, callProvider, computeCost } = await import('../llm/provider.js');
  const { getConfig } = await import('../config/loader.js');
  const agentsConfig = getConfig('agents');
  const modelKey = 'claude-haiku-4-5-20251001';
  const llm = createLLMClient(modelKey, agentsConfig.models);

  const response = await callProvider(llm, {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 2048,
    temperature: 0.1,
  });

  const costUsd = computeCost(
    response.inputTokens || 0,
    response.outputTokens || 0,
    llm.modelConfig
  );

  // Parse. The model occasionally wraps JSON in a fence despite the
  // instructions, so strip fences defensively.
  const raw = (response.text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  /** @type {Finding[]} */
  let findings = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.findings)) {
      findings = parsed.findings
        // Defensive: enforce shape + caps so a malformed finding can't wreck the UI.
        .filter((f) => f && ['G2', 'G7'].includes(f.gate)
                        && ['info', 'warn', 'block'].includes(f.severity))
        .map((f) => ({
          gate: f.gate,
          severity: f.severity,
          title: String(f.title || '').slice(0, 80),
          excerpt: String(f.excerpt || '').slice(0, 240),
          reason: String(f.reason || '').slice(0, 400),
        }));
    }
  } catch (err) {
    // STAQPRO-547: do NOT silently swallow a parse failure. An unparseable
    // model response means the G2/G7 scan effectively did not run — returning
    // an empty findings list here is a fail-open that lets the operator (or
    // the /send re-check) proceed as if the contract were clean. Surface the
    // failure so callers can fail closed (warn the operator / inject a
    // sentinel finding) instead of treating it as "no findings".
    log.warn({ err: err.message, raw: raw.slice(0, 200) }, 'Failed to parse pre-send findings JSON');
    return {
      findings: [],
      parseError: true,
      parseErrorMsg: err.message,
      costUsd,
      model: modelKey,
      ragSkipped,
    };
  }

  log.info({
    draftId,
    findings: findings.length,
    costUsd,
    priorContracts: priorContracts.length,
  }, 'Pre-send check complete');

  return { findings, costUsd, model: modelKey, ragSkipped };
}
