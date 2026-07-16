/**
 * Signal Ingester: create inbox.messages + inbox.signals rows WITHOUT a work_item.
 *
 * This is Tier 3 of the webhook routing system:
 * - Tier 1: Direct work_item (board pre-authorized, e.g. auto-fix label)
 * - Tier 2: Intent (creates agent_intents row for board review)
 * - Tier 3: Signal-only (this module — surfaces in briefings, zero LLM cost)
 *
 * Reuses the webhook insertion pattern from api.js lines 960-1002
 * but stops before createWorkItem().
 *
 * P1: Deny by default — only called when routing config explicitly directs here.
 * P3: Transparency by structure — signals are logged, not chosen.
 * P4: Boring infrastructure — raw SQL, no ORM.
 */

import { query } from '../db.js';
import { promoteSignalsLive } from '../../../lib/runtime/promote-live.js';
import { classifyMachineNotification } from '../../../lib/runtime/triage-header-sniff.js';

// ── OPT-68 INVARIANT: structural-only classification fields ─────────────────
//
// `direction` and `domain` are the two inputs to the ADR-008 reversibility
// gate (deriveReversibilityFlags in lib/runtime/signals/signal-action-bridge.js).
// They MUST derive from structured envelope metadata only — never from
// free-text content analysis or LLM output. A prompt injection that claims
// "internal, no external recipients" in the message body must have zero effect
// on these columns.
//
// Enforcement (P2 — infrastructure enforces, never prompts):
//   • `domain`    — allowlist below + normalizeDomain(); unknown → NULL (not
//                   'general'). The DB CHECK constraint is the backstop.
//   • `direction` — allowlist below + normalizeDirection(); unknown/LLM-inferred
//                   → NULL. NULL direction on a commitment/request is treated
//                   as EXTERNAL (fail-safe) by deriveReversibilityFlags:
//                   unknownDirectionSendType = true → hasExternalRecipient = true
//                   → route to 'gated'. Defaulting to 'inbound' on unknown
//                   direction would be a under-gating vulnerability.
//
// Provenance per attribute:
//   signal_type  — inbox.signals.signal_type TEXT CHECK ('commitment','request',
//                  'action_item',…); set by signal-detector (regex, structural)
//                  or webhook callers; never from free-text analysis.
//   direction    — inbox.signals.direction TEXT CHECK ('inbound','outbound','both');
//                  set ONLY via normalizeDirection() in this file; unknown → NULL
//                  (fail-safe to external). Writable only by this ingester.
//   domain       — inbox.signals.domain TEXT CHECK ('general','financial','legal',
//                  'scheduling'); set ONLY via normalizeDomain() in this file;
//                  unknown → NULL (not 'financial'/'legal'). Writable only here.
//   has_external_recipient — derived at bridge-time from direction (structural DB
//                  column); never stored on the row, never LLM-computed.
//   touches_money/touches_legal — derived at bridge-time from domain (structural
//                  DB column); never stored on the row, never LLM-computed.
//
// Related: ADR-008 (reversibility gate), ADR-013 (signal taxonomy), OPT-68.
// ─────────────────────────────────────────────────────────────────────────────

// STAQPRO-321: must match the CHECK constraint in sql/001-baseline.sql at
// the `signals.domain` column. Keep these in sync — adding a new value
// requires a migration that widens the CHECK.
const ALLOWED_SIGNAL_DOMAINS = new Set(['general', 'financial', 'legal', 'scheduling']);
const _unknownDomainsWarned = new Set();

// OPT-68: must match the CHECK constraint in sql/001-baseline.sql at the
// `signals.direction` column. Keep in sync with schema. Unknown → NULL (never
// 'inbound' — see OPT-68 INVARIANT above for why).
const ALLOWED_SIGNAL_DIRECTIONS = new Set(['inbound', 'outbound', 'both']);
const _unknownDirectionsWarned = new Set();

/**
 * Coerce a domain value to one the CHECK constraint accepts.
 * Returns null for empty/unknown values (column is nullable) and emits a
 * one-shot warning per (source, value) pair so a misbehaving source surfaces
 * quickly without spamming logs.
 */
export function normalizeDomain(raw, source = 'unknown') {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (ALLOWED_SIGNAL_DOMAINS.has(v)) return v;
  const key = `${source}::${v}`;
  if (!_unknownDomainsWarned.has(key)) {
    _unknownDomainsWarned.add(key);
    console.warn(`[signal-ingester] domain "${v}" from source=${source} is not in allowlist; coercing to NULL. Allowed: ${[...ALLOWED_SIGNAL_DOMAINS].join(', ')}`);
  }
  return null;
}

/**
 * OPT-68: Coerce a direction value to one the CHECK constraint accepts.
 *
 * CRITICAL — fail-safe default is NULL, not 'inbound':
 * Unknown/unrecognized direction → NULL → deriveReversibilityFlags treats
 * commitment/request signals as external (unknownDirectionSendType=true →
 * hasExternalRecipient=true → gated). Defaulting to 'inbound' on unknown
 * direction would silently under-gate an actual outbound commitment.
 *
 * Callers MUST supply a direction derived from envelope structure (e.g. Gmail
 * SMTP headers, Linear webhook direction field) — never from LLM content
 * analysis or message body parsing.
 *
 * @param {string|null|undefined} raw
 * @param {string} [source]
 * @returns {'inbound'|'outbound'|'both'|null}
 */
export function normalizeDirection(raw, source = 'unknown') {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (ALLOWED_SIGNAL_DIRECTIONS.has(v)) return v;
  const key = `${source}::${v}`;
  if (!_unknownDirectionsWarned.has(key)) {
    _unknownDirectionsWarned.add(key);
    console.warn(`[signal-ingester] direction "${v}" from source=${source} is not in allowlist; coercing to NULL (fail-safe: external). Allowed: ${[...ALLOWED_SIGNAL_DIRECTIONS].join(', ')}`);
  }
  return null;
}

/** Test-only — reset the throttled-warning memos. */
export function _resetDomainWarningsForTest() {
  _unknownDomainsWarned.clear();
  _unknownDirectionsWarned.clear();
}

/**
 * Ingest a webhook event as signal-only (no work_item created).
 *
 * @param {Object} opts
 * @param {string} opts.source - Webhook source identifier (e.g. 'linear', 'github', 'tldv')
 * @param {string} opts.title - Short title for the message
 * @param {string} opts.snippet - Body/description text (truncated to 2000 chars)
 * @param {string} opts.from - Sender identifier
 * @param {Array<Object>} opts.signals - Array of signal objects to create
 * @param {string} opts.signals[].signal_type - ADR-014 signal type (commitment, deadline, request, question, etc.)
 * @param {string} opts.signals[].content - Signal content text
 * @param {number} [opts.signals[].confidence] - Confidence score 0-1 (default 0.8)
 * @param {string} [opts.signals[].direction] - 'inbound' | 'outbound' | 'internal' (default 'inbound')
 * @param {string} [opts.signals[].domain] - Domain category (default null)
 * @param {Object} [opts.metadata] - Additional metadata for the message
 * @param {string[]} [opts.labels] - Additional labels (webhook:<source> and signal-only auto-added)
 * @param {string} [opts.providerMsgId] - Provider message ID for dedup (auto-generated if not provided)
 * @param {string} [opts.threadId] - Thread ID for grouping related signals
 * @param {string} [opts.channel] - Logical channel for the noise gate (e.g. 'github'). Defaults to `source`.
 * @param {string} [opts.eventType] - Structured event type (e.g. 'push', 'check_run') for the noise gate.
 * @param {string|number|null} [opts.linkedWorkItemId] - Owned work_item this event is tied to. When set, the noise gate never fires.
 * @returns {{ messageId: number, signalIds: number[] }}
 */
export async function ingestAsSignal({
  source,
  title,
  snippet,
  from,
  signals = [],
  metadata = {},
  labels = [],
  providerMsgId = null,
  threadId = null,
  channel = null,
  eventType = null,
  linkedWorkItemId = null,
}) {
  // STAQPRO-562: deterministic pre-promotion noise gate. Keyed ONLY on
  // structured fields (channel + event type + linked work_item) — never on
  // body content or an LLM. Unlinked GitHub/CI events (push/check_run/
  // workflow_run/status/…) are classified `noise` and NEVER promoted to a
  // human surface; they still get a row (P3: transparency by structure) but
  // skip promoteSignalsLive entirely. A linked, owned work_item bypasses the
  // gate (it has a real handler upstream).
  const noiseVerdict = classifyMachineNotification({
    channel: channel || source,
    eventType,
    linkedWorkItemId,
  });
  // Normalize and truncate attacker-controlled fields
  const safeTitle = String(title || `Signal from ${source}`).slice(0, 500);
  const safeSnippet = String(snippet || '').slice(0, 2000) || `[${source} signal event]`;
  const safeFrom = String(from || source).slice(0, 255);
  const safeMsgId = providerMsgId
    || `sig_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safeThreadId = threadId || `sig_thread_${safeMsgId}`;

  // Build labels: always include source tag and signal-only marker. When the
  // deterministic gate flags this as machine noise, tag it so the surface
  // filters can exclude it and the reason is auditable.
  const allLabels = [
    `webhook:${source}`,
    'signal-only',
    ...(noiseVerdict ? ['machine-notification', `noise-reason:${noiseVerdict.reason}`] : []),
    ...labels.filter(l => l && typeof l === 'string').map(l => l.slice(0, 100)),
  ];

  // Insert message into inbox (same pattern as api.js webhook handler).
  // When the deterministic gate fired, persist triage_category='noise' up
  // front (confidence 1.0) so the row is correctly classified without ever
  // touching a model.
  const msgResult = await query(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, channel, thread_id, message_id,
      from_address, from_name, to_addresses, subject, snippet,
      received_at, labels, has_attachments, channel_id,
      triage_category, triage_confidence, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (channel, channel_id) WHERE channel_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      safeMsgId, 'webhook', 'webhook',
      safeThreadId, `<${safeMsgId}@webhook>`,
      safeFrom, source, ['system@autobot'],
      safeTitle, safeSnippet,
      new Date().toISOString(), allLabels,
      false, safeMsgId,
      noiseVerdict ? 'noise' : 'pending',
      noiseVerdict ? 1.0 : null,
      noiseVerdict ? new Date().toISOString() : null,
    ]
  );

  // Dedup: if ON CONFLICT triggered, return null (already ingested)
  if (msgResult.rows.length === 0) {
    console.log(`[signal-ingester] Dedup: skipped duplicate signal for ${source} msgId=${safeMsgId}`);
    return null;
  }

  const messageId = msgResult.rows[0].id;

  // Insert signals using existing ADR-014 schema
  const signalIds = [];
  for (const sig of signals) {
    if (!sig.signal_type || !sig.content) continue;

    // STAQPRO-321: defensive domain normalization. The schema's
    // signals_domain_check constraint allows only ('general', 'financial',
    // 'legal', 'scheduling'). Sources that supply anything else (e.g.
    // Linear team names like "Staqs Internal Projects") used to throw
    // inside this try-catch and the signal got silently dropped (0
    // signal(s) ingested). Now: coerce unknown values to NULL and log
    // one warning per unique value so the bad source surfaces, then
    // continue with the insert.
    const normalizedDomain = normalizeDomain(sig.domain, source);
    // OPT-68: normalizeDirection() enforces the allowlist and defaults unknown
    // values to NULL (not 'inbound') so the reversibility gate treats them as
    // external (fail-safe). Never pass sig.direction through raw — callers may
    // have inferred it from LLM content analysis.
    const normalizedDirection = normalizeDirection(sig.direction, source);

    try {
      const sigResult = await query(
        `INSERT INTO inbox.signals
         (message_id, signal_type, content, confidence, direction, domain)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          messageId,
          String(sig.signal_type).slice(0, 50),
          String(sig.content).slice(0, 2000),
          sig.confidence ?? 0.8,
          normalizedDirection,
          normalizedDomain,
        ]
      );
      if (sigResult.rows[0]) {
        signalIds.push(sigResult.rows[0].id);
      }
    } catch (err) {
      console.warn(`[signal-ingester] Failed to insert signal: ${err.message}`);
    }
  }

  // Store source-specific metadata on the message (best-effort)
  if (Object.keys(metadata).length > 0) {
    try {
      await query(
        `UPDATE inbox.messages SET metadata = $1 WHERE id = $2`,
        [JSON.stringify(metadata), messageId]
      );
    } catch {
      // metadata column may not exist — non-fatal
    }
  }

  console.log(`[signal-ingester] Ingested ${source} signal: msgId=${messageId}, ${signalIds.length} signal(s)${noiseVerdict ? ` [noise: ${noiseVerdict.reason}, not promoted]` : ''}`);

  // STAQPRO-562: machine noise is NEVER promoted to a human surface. The row
  // exists for audit (P3) but stops here — no human_tasks card, no Telegram/
  // Slack/Board surfacing. Surfacing noise is worse than silence.
  if (noiseVerdict) {
    return { messageId, signalIds, noise: true, noiseReason: noiseVerdict.reason };
  }

  // ADR-008 Stream A — LIVE promotion. Promote freshly-ingested obligations to
  // resolvable, relevance-gated inbox.human_tasks cards (isStillLive skips dead
  // ones) instead of leaving them as orphaned signals. Best-effort + non-blocking.
  if (signalIds.length > 0) {
    try {
      await promoteSignalsLive({
        query,
        signalIds,
        log: (msg) => console.log(`[signal-ingester] ${msg}`),
      });
    } catch (err) {
      console.warn(`[signal-ingester] live promotion failed (non-fatal): ${err.message}`);
    }
  }

  return { messageId, signalIds };
}
