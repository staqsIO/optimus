/**
 * Signal Detector — ambient capture on every qualifying agent message.
 *
 * Worktree B1 of the gbrain-adoption plan. The pattern originated in gbrain
 * (Garry Tan's brain pack): the agent runtime opportunistically extracts
 * notable claims, time-sensitive todos, and named entities from messages
 * that flow through the system. This is the "fat skills, thin harness"
 * inversion — capture happens by structure (post-message hook), not by
 * an agent remembering to call a tool (P3, transparency by structure).
 *
 * Scope (B1 only):
 *   - Phase 1 (idea/observation): regex extraction of action items,
 *     deadlines, requests, decisions — written to inbox.signals.
 *   - Phase 2 (entity):           regex extraction of email-address-shaped
 *     identifiers — upserted into signal.contacts with interaction_count++
 *     via emails_received increment.
 *
 * Out of scope (deferred to later worktrees):
 *   - LLM-based extraction (B1 is regex-only so it stays cheap and stays
 *     well under the "non-blocking" guarantee — no network calls).
 *   - Retiring lib/pattern-extractor (B2).
 *   - Nightly enrichment cron (B3).
 *   - Brain-first retrieval (B4).
 *
 * Tenancy correctness (CRITICAL):
 *   - inbox.signals.message_id is a FK to inbox.messages(id). All extracted
 *     signals scope through the message — we never invent a synthetic message.
 *   - signal.contacts.email_address is the natural key; the table's
 *     account_id-shaped column (source_account_id) is the email/OAuth
 *     connector identity, NOT a board-member tenant identifier.
 *   - The TENANT id you care about is `ownerId` (UUID → board_members.id),
 *     resolved upstream by the caller via `work_item.account_id →
 *     inbox.accounts.owner_id`. Even though signal.contacts is not currently
 *     FORCE'd by migration 126, we still execute writes through `scopedQuery`
 *     (a withAgentScope handle) so that current_agent_id() / app.org are
 *     set when future migrations enable RLS on signal.* tables.
 *
 * Non-blocking contract:
 *   - This function MUST NOT throw outward when called from the agent loop.
 *     The agent loop wraps the call in try/catch and downgrades errors to a
 *     warn-level log. We still throw on programming-level errors (missing
 *     scopedQuery) so the bug surfaces in dev, but DB-write failures are
 *     swallowed and counted in the returned `errors` array.
 *
 * P1: Deny by default — extraction is opt-in via SIGNAL_DETECTOR_ENABLED.
 * P2: Infrastructure enforces — gate is in the runtime, not in agent prompts.
 * P3: Transparency by structure — every detection emits a structured log line.
 * P4: Boring infrastructure — regex + parameterized SQL, no ML.
 */

import { createLogger } from '../../logger.js';

const log = createLogger('runtime/signal-detector');

// ── Skip gate ──────────────────────────────────────────────────────

/**
 * Lowercased operational-message stopwords. A message whose normalized form
 * is exactly one of these is treated as conversational noise (acknowledgement,
 * single-word reply, etc.) and skipped. Kept tight on purpose — we err on the
 * side of running the detector rather than dropping a real signal.
 */
const STOPWORD_MESSAGES = new Set([
  'ok', 'okay', 'thanks', 'thank you', 'thx', 'ty',
  'do it', 'sure', 'fine', 'yes', 'no', 'yep', 'nope',
  'k', 'kk', 'got it', 'cool', 'noted', '+1', 'lgtm',
]);

const MIN_MESSAGE_LENGTH = 8;
const MAX_MESSAGE_LENGTH = 50_000; // guardrail; longer messages skip Phase 1 regex

/**
 * Decide whether a message should be processed by the detector.
 *
 * Order of precedence:
 *   1. Falsy / non-string → skip (`empty`)
 *   2. Length < MIN_MESSAGE_LENGTH → skip (`too_short`)
 *   3. Length > MAX_MESSAGE_LENGTH → skip (`too_long`)
 *   4. Normalized form matches stopword set → skip (`stopword`)
 *   5. Caller-provided classification flagged as operational → skip (`classifier_operational`)
 *   6. Otherwise → run (`null` reason)
 *
 * The caller may pass `classification: 'operational' | 'noise'` to short-
 * circuit on existing classifier output (e.g. executor-intake's result).
 * We do NOT call any classifier ourselves — that would defeat the
 * non-blocking goal.
 *
 * @param {string} message
 * @param {{ classification?: string }} [hints]
 * @returns {{ skip: boolean, reason: string | null }}
 */
export function shouldSkip(message, hints = {}) {
  if (!message || typeof message !== 'string') return { skip: true, reason: 'empty' };
  const trimmed = message.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH) return { skip: true, reason: 'too_short' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { skip: true, reason: 'too_long' };
  const normalized = trimmed.toLowerCase().replace(/[.!?]+$/, '');
  if (STOPWORD_MESSAGES.has(normalized)) return { skip: true, reason: 'stopword' };
  if (hints.classification === 'operational' || hints.classification === 'noise') {
    return { skip: true, reason: 'classifier_operational' };
  }
  return { skip: false, reason: null };
}

// ── Phase 1: extract ideas/observations ───────────────────────────

/**
 * Regex patterns that mark a sentence as a noteworthy signal. Each pattern
 * maps to a signal_type from inbox.signals.signal_type CHECK constraint:
 *   commitment | deadline | request | question | approval_needed |
 *   decision | introduction | info | action_item
 *
 * Patterns are deliberately conservative — false negatives are fine
 * (the LLM-pass in a future worktree will catch what regex misses);
 * false positives pollute the signals feed and are expensive to clean up.
 */
const IDEA_PATTERNS = [
  // commitments: "i will", "we'll", "i'll get back"
  { type: 'commitment', re: /\b(?:i|we)['’]?(?:ll| will)\s+(?:get|send|do|handle|review|sign|ship|deploy|fix|finish|deliver|make|build|write|update|circle back|follow up|get back)\b[^.!?\n]{0,160}/i },
  // deadlines: "by friday", "by 5pm", "by tomorrow", "next week", "EOD"
  { type: 'deadline', re: /\bby\s+(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|EOD|EOW|EOM|end of (?:day|week|month)|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{4}-\d{2}-\d{2})\b[^.!?\n]{0,160}/i },
  // requests: "can you", "could you", "please review/send/check"
  { type: 'request', re: /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:review|send|check|approve|sign|confirm|share|forward|update|look at|take a look)\b[^.!?\n]{0,160}/i },
  // approvals: explicit ask for sign-off
  { type: 'approval_needed', re: /\b(?:need(?:s|ed)?|require(?:s|d)?)\s+(?:your\s+)?(?:approval|sign-?off|review|go[\s-]?ahead)\b[^.!?\n]{0,160}/i },
  // decisions: "we decided", "going with", "let's go with"
  { type: 'decision', re: /\b(?:we (?:decided|chose|picked)|going with|let['’]s go with|decided to)\b[^.!?\n]{0,160}/i },
  // questions: ends with ? and looks substantive
  { type: 'question', re: /\b(?:what|when|why|how|where|who|which|should we|can we|do you think)\b[^.!?\n]{6,160}\?/i },
  // action items: "todo:", "TODO ", "action item:"
  { type: 'action_item', re: /\b(?:TODO|todo:|action item|next steps?:|follow[\s-]?up:?)\b[^.\n]{0,160}/i },
];

/**
 * Extract idea-class signals from a message body. Returns up to N candidates,
 * deduplicated by trimmed content. Capped at 8 to keep the per-message DB
 * footprint bounded.
 *
 * @param {string} message
 * @returns {Array<{ signal_type: string, content: string, confidence: number }>}
 */
export function extractIdeas(message) {
  const out = [];
  const seen = new Set();
  for (const { type, re } of IDEA_PATTERNS) {
    const match = message.match(re);
    if (!match) continue;
    const content = match[0].trim().slice(0, 500);
    const dedupKey = `${type}::${content.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ signal_type: type, content, confidence: 0.55 });
    if (out.length >= 8) break;
  }
  return out;
}

// ── Phase 2: extract entities ─────────────────────────────────────

// RFC-5322ish — intentionally narrower than full RFC since we only want
// addresses that look like real human/system inboxes, not edge-case URIs.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){1,3}\b/g;

/**
 * Extract person/company entities (email addresses for now) from a message.
 * Returns deduplicated, lowercased addresses, capped at 16 per message.
 *
 * Future expansion: @mentions, capitalized noun chunks, company suffixes.
 * Kept email-only in B1 to match what signal.contacts.email_address
 * (the natural key) can actually store.
 *
 * @param {string} message
 * @returns {Array<{ email_address: string, name: string | null }>}
 */
export function extractEntities(message) {
  const out = [];
  const seen = new Set();
  const matches = message.match(EMAIL_RE) || [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email_address: email, name: null });
    if (out.length >= 16) break;
  }
  return out;
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Detect ambient signals from an agent message and persist them.
 *
 * Idempotency: this function does NOT track whether it has already been
 * called for a given (message_id, agent) pair. Callers are responsible for
 * not double-invoking. The agent loop calls this once per completed tick.
 *
 * @param {Object} args
 * @param {string} args.message              The agent-produced (or processed) message body.
 * @param {Object} [args.workItem]           The current work item (used for telemetry only).
 * @param {string} args.messageId            FK target for inbox.signals.message_id. Required.
 * @param {string} args.agentId              The detecting agent's id (for log lines).
 * @param {string | null} args.ownerId       Resolved board-member UUID, or null when unknown.
 * @param {Object} args.scopedQuery          A withAgentScope() handle. Required — we never call
 *                                           the bare `query()` so RLS context is always set.
 * @param {{ classification?: string }} [args.hints]
 * @returns {Promise<{
 *   skipped: boolean,
 *   reason: string | null,
 *   ideas: Array<{ id: string, signal_type: string }>,
 *   entities: Array<{ email_address: string, contact_id: string | null }>,
 *   errors: Array<{ phase: string, message: string }>,
 * }>}
 */
export async function detectSignals(args) {
  const {
    message,
    workItem = null,
    messageId,
    agentId,
    ownerId = null,
    scopedQuery,
    hints = {},
  } = args || {};

  // Programming-error guards — these SHOULD throw so misuse surfaces in
  // dev. The agent-loop wrapper catches and logs, so production won't crash.
  if (!scopedQuery || typeof scopedQuery !== 'function') {
    throw new Error('signal-detector: scopedQuery is required (must be a withAgentScope handle)');
  }
  if (!messageId) {
    throw new Error('signal-detector: messageId is required (FK to inbox.messages.id)');
  }

  const result = {
    skipped: false,
    reason: null,
    ideas: [],
    entities: [],
    errors: [],
  };

  // 1. Skip gate
  const gate = shouldSkip(message, hints);
  if (gate.skip) {
    result.skipped = true;
    result.reason = gate.reason;
    log.debug(`[${agentId}] signal-detector skip: ${gate.reason} (msg=${messageId})`);
    return result;
  }

  // 2. Phase 1 — ideas/observations → inbox.signals
  const ideas = extractIdeas(message);
  for (const idea of ideas) {
    try {
      const r = await scopedQuery(
        `INSERT INTO inbox.signals
           (message_id, signal_type, content, confidence, direction, domain, metadata)
         VALUES ($1, $2, $3, $4, 'inbound', 'general', $5)
         RETURNING id`,
        [
          messageId,
          idea.signal_type,
          idea.content,
          idea.confidence,
          JSON.stringify({
            source: 'signal-detector',
            agent_id: agentId,
            owner_id: ownerId,
            work_item_id: workItem?.id || workItem?.work_item_id || null,
          }),
        ],
      );
      result.ideas.push({ id: r.rows[0]?.id || null, signal_type: idea.signal_type });
    } catch (err) {
      result.errors.push({ phase: 'idea', message: err.message });
      log.warn(`[${agentId}] signal-detector idea insert failed: ${err.message}`);
    }
  }

  // 3. Phase 2 — entities → signal.contacts (upsert + interaction count)
  const entities = extractEntities(message);
  for (const ent of entities) {
    try {
      const r = await scopedQuery(
        `INSERT INTO signal.contacts (email_address, name, source_account_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (email_address) DO UPDATE SET
           emails_received = signal.contacts.emails_received + 1,
           last_received_at = now(),
           name = COALESCE(EXCLUDED.name, signal.contacts.name),
           updated_at = now()
         RETURNING id`,
        [ent.email_address, ent.name, ownerId],
      );
      result.entities.push({
        email_address: ent.email_address,
        contact_id: r.rows[0]?.id || null,
      });
    } catch (err) {
      result.errors.push({ phase: 'entity', message: err.message });
      log.warn(`[${agentId}] signal-detector entity upsert failed: ${err.message}`);
    }
  }

  log.info(
    `[${agentId}] signal-detector: msg=${messageId} ideas=${result.ideas.length} ` +
    `entities=${result.entities.length} errors=${result.errors.length} owner=${ownerId || 'none'}`,
  );
  return result;
}

// ── Feature flag helper ───────────────────────────────────────────

/**
 * Single source of truth for the SIGNAL_DETECTOR_ENABLED flag. Default OFF
 * so the rollout is a Railway env-var flip, not a code change.
 *
 * Accepts any of '1', 'true', 'yes', 'on' (case-insensitive) as enabled.
 *
 * @returns {boolean}
 */
export function isEnabled() {
  const raw = process.env.SIGNAL_DETECTOR_ENABLED;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
