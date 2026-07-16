/**
 * Signal → agent-work bridge (Stream B of ADR-008).
 *
 * This is the missing half of the loop. inbox.signals is a telemetry layer
 * today — obligations are extracted, displayed, and orphaned (2,629 unresolved
 * in prod). This module connects a signal to agent-actionable work, classifying
 * it by REVERSIBILITY (ADR-008 §2) rather than by a human-tier dial:
 *
 *   - autonomous (reversible): spawn a status='created' work_item; an executor
 *     runs it to completion immediately. No board card. The irreversible step,
 *     if any, still hits the EXISTING guardCheck/checkDraftGates downstream.
 *   - gated (irreversible): spawn the work_item AND a visible inbox.human_tasks
 *     card. A status='blocked' work_item alone is NOT surfaced to humans —
 *     guard-check.js only blocks AGENT CLAIM of it (Linus blocker #1).
 *
 * Precedent: lib/contracts/spawn-work-items.js (atomic-claim -> create work_item
 * -> provenance). Reuses extractObligor from signal-task-promoter.js.
 *
 * P-compliance: parameterized queries only (P2/P4); content_hash dedup is
 * deterministic infrastructure (P1 at-most-once), not a prompt; provenance is a
 * side effect of operating, not an opt-in (P3).
 *
 * Schema: inbox.signals bridge columns (occurred_at, work_item_id, contact_id,
 * bridged_at, content_hash) + signals_bridge_dedup / signals_bridge_eligible
 * indexes are added by autobot-inbox/sql/127-signal-action-bridge.sql.
 */

import { createHash } from 'node:crypto';
import { createChildLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
import { withTransaction } from '../../db.js';
import { createWorkItem } from '../state-machine.js';
import { notify } from '../event-bus.js';
import { extractObligor } from '../signal-task-promoter.js';
import { obligationTypeForSignal } from './obligation-type.js';

const log = createChildLogger({ module: 'runtime/signal-action-bridge' });

const TITLE_CAP = 200;
const DESCRIPTION_CAP = 2000;

// OPT-154: contact metadata.status / metadata.departed values that mark a contact
// as no longer a live counterparty. Module-scoped so it's built once, not per call.
const DEPARTED_CONTACT_STATUSES = new Set(['departed', 'inactive', 'former', 'terminated']);

/**
 * Load + memoize the signal-routing config. Falls back to documented defaults
 * if the file is missing so unit tests and dry-runs never hard-fail on config.
 * @returns {Object}
 */
function routingConfig() {
  try {
    return getConfig('signal-routing');
  } catch (err) {
    log.warn({ err: err.message }, 'signal-routing.json not loadable; using built-in defaults');
    return {
      dryRun: true,
      staleCleanupOnly: true,
      confidenceThreshold: 0.70,
      reviewBandFloor: 0.70,
      reviewBandCeiling: 0.85,
      staleness: { occurredWithinDays: 45, dueWithinDays: 7 },
      notLiveContactTiers: ['automated'],
      eligibleSignalTypes: ['commitment', 'request', 'action_item'],
      batchSize: 25,
      perRunCostCapUsd: 2.5,
      ragSupersedeCheck: false,
    };
  }
}

// ── OPT-68 INVARIANT: structural-only reversibility classification ────────────
//
// ADR-008 §2 reversibility gate: (signal_type, has_external_recipient,
// touches_money, touches_legal) → { autonomous | gated }. Each of the 4
// inputs MUST derive exclusively from structured DB columns — never from
// LLM-inferred or free-text content analysis. A prompt injection whose
// message body claims "internal task, no external recipients" must have zero
// effect on the classification.
//
// Attribute provenance (P2 — infrastructure enforces, never prompts):
//
//   signal_type          — inbox.signals.signal_type TEXT CHECK constraint;
//                          set by signal-detector (pure regex, no LLM) or
//                          webhook callers via signal-ingester.js.
//
//   direction (→ has_external_recipient)
//                        — inbox.signals.direction TEXT CHECK
//                          ('inbound','outbound','both'); enforced at write-time
//                          by normalizeDirection() in signal-ingester.js.
//                          Unknown/LLM-inferred values → NULL (not 'inbound').
//                          NULL direction on commitment/request → treated as
//                          EXTERNAL here (unknownDirectionSendType=true, fail-
//                          safe). A prompt injection claiming 'inbound' cannot
//                          succeed if the value was not in the structural
//                          allowlist — it was coerced to NULL → gated.
//
//   domain (→ touches_money / touches_legal)
//                        — inbox.signals.domain TEXT CHECK
//                          ('general','financial','legal','scheduling'); enforced
//                          at write-time by normalizeDomain() in signal-ingester.
//                          Unknown/LLM-inferred → NULL (not 'financial'/'legal').
//
//   confidence (→ review_band gate)
//                        — inbox.signals.confidence NUMERIC(4,3); set by
//                          signal-detector regex scoring; never LLM-assigned.
//
// deriveReversibilityFlags() reads ONLY these structural DB columns. It
// performs no I/O, no LLM calls, no content inspection — pure function.
//
// Related: ADR-008 (reversibility gate), ADR-013 (signal taxonomy), OPT-68.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the irreversibility-relevant booleans from a signal row. Kept separate
 * (and pure) so routeObligation stays a one-look decision table and so the
 * derivation is unit-testable in isolation.
 *
 * OPT-68: reads ONLY structural DB columns (direction, domain, signal_type).
 * Never reads sig.content or any LLM-produced field. See OPT-68 INVARIANT above.
 *
 * @param {Object} sig - signal row (signal_type, direction, domain, msg_channel)
 * @returns {{hasExternalRecipient: boolean, touchesMoney: boolean, touchesLegal: boolean}}
 */
function deriveReversibilityFlags(sig) {
  const domain = (sig.domain || '').toLowerCase();
  const direction = (sig.direction || '').toLowerCase();
  const signalType = sig.signal_type;

  // An obligation has an external recipient when it is something WE send out:
  // an outbound commitment/request crosses an org boundary to a counterparty.
  // Inbound obligations (someone asked US) do not send anything external.
  //
  // OPT-68 FAIL-SAFE: a commitment/request with an UNKNOWN direction
  // (null/empty/unrecognized) might be an external send — we cannot prove it is
  // internal, so we treat it as external (gated). NULL direction arises when
  // normalizeDirection() in signal-ingester.js rejected an unrecognized or
  // LLM-inferred value. A prompt injection claiming 'inbound' cannot succeed:
  // if the value was not in the structural allowlist it was coerced to NULL here.
  const knownDirection = direction === 'inbound' || direction === 'outbound' || direction === 'both';
  const unknownDirectionSendType =
    !knownDirection && (signalType === 'commitment' || signalType === 'request');
  const hasExternalRecipient =
    direction === 'outbound' || direction === 'both' || unknownDirectionSendType;

  // touches_money / touches_legal: from domain column only (structural).
  // Unknown/LLM-inferred domain was coerced to NULL by normalizeDomain() →
  // neither flag fires (false). A prompt injection cannot claim
  // domain='financial' — the column value comes from the structured envelope.
  const touchesMoney = domain === 'financial';
  const touchesLegal = domain === 'legal';

  return { hasExternalRecipient, touchesMoney, touchesLegal };
}

/**
 * PURE deterministic reversibility classifier (ADR-008 §2). No I/O, no clock,
 * no randomness — same input always yields the same class. This is the gate:
 * "default to act; gate only the irreversible."
 *
 * Rule table (first match wins):
 *   1. domain legal                          -> gated  (legal commitment)
 *   2. domain financial / touches money      -> gated  (money out the door)
 *   3. external send (commitment/request     -> gated  (external counterparty send;
 *      with external recipient — incl.                also fires for UNKNOWN
 *      unknown direction, fail-safe)                  direction, fail-safe)
 *   4. confidence in [reviewBandFloor,       -> gated  (force human review of the
 *      reviewBandCeiling)                              classification itself)
 *   5. inbound request                       -> autonomous: executor-responder (draft)
 *   6. action_item                           -> autonomous: executor-ticket (Linear)
 *   7. outbound commitment (internal-only)   -> autonomous: internal work_item
 *   8. anything else reversible              -> autonomous: internal work_item
 *
 * @param {Object} sig - { signal_type, direction, domain, confidence }
 * @param {Object} [cfg] - routing config (defaults loaded if omitted)
 * @returns {{ klass: 'autonomous'|'gated', targetExecutor: string|null, reason: string }}
 */
export function routeObligation(sig, cfg = routingConfig()) {
  const signalType = sig?.signal_type;
  const direction = (sig?.direction || '').toLowerCase();
  const confidence = typeof sig?.confidence === 'number'
    ? sig.confidence
    : Number(sig?.confidence);

  const { hasExternalRecipient, touchesMoney, touchesLegal } = deriveReversibilityFlags(sig || {});

  const floor = typeof cfg?.reviewBandFloor === 'number' ? cfg.reviewBandFloor : 0.70;
  const ceiling = typeof cfg?.reviewBandCeiling === 'number' ? cfg.reviewBandCeiling : 0.85;

  // 1-2: legal / financial domain is always irreversible.
  if (touchesLegal) {
    return { klass: 'gated', targetExecutor: null, reason: 'legal_domain' };
  }
  if (touchesMoney) {
    return { klass: 'gated', targetExecutor: null, reason: 'financial_domain' };
  }

  // 3: an outbound commitment/request to an external counterparty is a send.
  if (hasExternalRecipient && (signalType === 'commitment' || signalType === 'request')) {
    return { klass: 'gated', targetExecutor: null, reason: 'external_counterparty_send' };
  }

  // 4: mid-confidence band -> force review of the classification itself.
  if (Number.isFinite(confidence) && confidence >= floor && confidence < ceiling) {
    return { klass: 'gated', targetExecutor: null, reason: 'confidence_review_band' };
  }

  // 5-8: reversible -> act autonomously. An unknown-direction request was
  // already caught as a fail-safe external send in rule 3, so reaching here as a
  // request means direction is genuinely inbound.
  if (signalType === 'request' && direction === 'inbound') {
    return { klass: 'autonomous', targetExecutor: 'executor-responder', reason: 'inbound_request_draft' };
  }
  if (signalType === 'action_item') {
    return { klass: 'autonomous', targetExecutor: 'executor-ticket', reason: 'action_item_ticket' };
  }
  if (signalType === 'commitment') {
    // Outbound-but-internal commitment, or any commitment that fell through the
    // gated checks above: track it as internal work, no external send.
    return { klass: 'autonomous', targetExecutor: null, reason: 'internal_commitment_work_item' };
  }

  return { klass: 'autonomous', targetExecutor: null, reason: 'reversible_default' };
}

/**
 * Normalize signal content for stable hashing across re-extractions. Lowercase,
 * collapse whitespace, trim. A re-ingested transcript yields a new signal id but
 * the same normalized content -> same content_hash -> dedup catches it.
 *
 * @param {string|null} content
 * @returns {string}
 */
function normalizeContent(content) {
  return String(content || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute the dedup key. sha256 hex of `normalized(content)|signal_type|message_id`.
 *
 * INVARIANT (load-bearing): cross-re-ingest dedup depends on `message_id` being
 * STABLE across re-ingestion of the same source. It is today — ingest is
 * idempotent on the provider/channel key (tl;dv: `inbox.messages` is looked up by
 * (channel, channel_id=meetingId) and the existing row id is reused, see
 * tldv/poller.js ensureTldvMessageAndWorkItem; Gmail: keyed on provider_msg_id),
 * so a re-processed transcript mints a new signal.id but reuses the same
 * message_id -> same hash -> dedup fires. If ingest is ever refactored to mint a
 * FRESH inbox.messages row on re-process, this hash changes across re-ingest and
 * the same obligation bridges twice with no test catching it. Keep message_id
 * provider-anchored, or drop it from the basis (accepting same-phrasing cross-
 * source collisions) if that invariant can't be guaranteed.
 *
 * @param {Object} sig - { content, signal_type, message_id }
 * @returns {string}
 */
function computeContentHash(sig) {
  const basis = `${normalizeContent(sig.content)}|${sig.signal_type || ''}|${sig.message_id || ''}`;
  return createHash('sha256').update(basis).digest('hex');
}

/**
 * Is this obligation still worth acting on? Context is PRIMARY; recency is the
 * cheap FALLBACK (ADR-008 §3 — Lester vanishes by truth, not by age).
 *
 * No side effects beyond the injected `query` callback (unit-testable: pass a
 * stub query). Does NOT mutate any row — the caller decides what to do with the
 * verdict.
 *
 * @param {Object} opts
 * @param {Function} opts.query - pg-style (text, params) => { rows }
 * @param {Object} opts.sig - signal row incl. contact_id, occurred_at, due_date
 * @param {Object} [opts.cfg] - routing config
 * @returns {Promise<{ live: boolean, reason: string }>}
 */
export async function isStillLive({ query, sig, cfg = routingConfig() }) {
  if (!query || !sig) throw new Error('isStillLive requires { query, sig }');

  const staleness = cfg?.staleness || { occurredWithinDays: 45, dueWithinDays: 7 };

  // OPT-154: contact tiers that are inherently not a live counterparty (e.g.
  // 'automated' — no-reply/system senders). Config-driven so it tunes without a
  // deploy; defaults to ['automated'] when the key is absent. Lower-cased set for
  // case-insensitive matching against signal.contacts.tier.
  const notLiveContactTiers = new Set(
    (Array.isArray(cfg?.notLiveContactTiers) ? cfg.notLiveContactTiers : ['automated'])
      .map((t) => String(t).toLowerCase()),
  );

  // ---- PRIMARY: context ----------------------------------------------------
  // (a) Not-live tier (OPT-154) or departed/inactive contact short-circuits
  //     everything. signal.contacts has no explicit "departed" column; the
  //     tier/metadata convention is the best signal available (assumption
  //     documented in the bridge report).
  // Fire the context branch whenever contact context is present (Linus major):
  // contact_id was the original bug (never populated). Now it also fires when the
  // LATERAL resolved a tier/metadata even if contact_id is somehow absent.
  if (sig.contact_id || sig.contact_tier !== undefined) {
    try {
      // Prefer the contact tier/metadata already resolved at signal-load time
      // (OPT-154 sender-address LATERAL in bridgeSignal); fall back to a direct
      // lookup so a caller that only set sig.contact_id (e.g. a focused unit
      // test, or a future writer that populates signals.contact_id) still works.
      // == null covers BOTH null (pg returns null for a NULL metadata column) and
      // undefined (Linus major): a join that resolved a contact whose metadata is
      // NULL must NOT take the fast path and skip the departed check.
      let tier = sig.contact_tier;
      let metaStatus;
      let departedFlag;
      if (tier === undefined || sig.contact_metadata == null) {
        const c = await query(
          `SELECT tier,
                  metadata->>'status'   AS meta_status,
                  metadata->>'departed' AS meta_departed
             FROM signal.contacts
            WHERE id = $1`,
          [sig.contact_id],
        );
        const row = c.rows[0];
        if (row) {
          // Only override tier from the DB when the load-time value was absent —
          // a resolved tier with NULL metadata still uses its real tier value.
          if (tier === undefined) tier = row.tier;
          metaStatus = row.meta_status;
          departedFlag = row.meta_departed;
        }
      } else {
        const meta = sig.contact_metadata || {};
        metaStatus = meta.status;
        departedFlag = meta.departed;
      }

      if (tier !== undefined && tier !== null) {
        const tierLc = String(tier).toLowerCase();
        if (notLiveContactTiers.has(tierLc)) {
          return { live: false, reason: `contact_${tierLc}` };
        }
      }

      const metaStatusLc = (metaStatus == null ? '' : String(metaStatus)).toLowerCase();
      const departedFlagLc = (departedFlag == null ? '' : String(departedFlag)).toLowerCase();
      if (DEPARTED_CONTACT_STATUSES.has(metaStatusLc) || departedFlagLc === 'true') {
        return { live: false, reason: `contact_${metaStatusLc || 'departed'}` };
      }
    } catch (err) {
      // FAILS OPEN BY DESIGN: a transient lookup error (e.g. missing contacts
      // table in a stripped test DB, pooler blip) must not block bridging — we
      // fall through to recency and ultimately may proceed live=true. Note this
      // only affects the ERROR path; a SUCCESSFUL lookup showing a departed
      // contact still returns live=false above. Warn (not debug) so a sustained
      // lookup outage is visible in logs rather than silently widening the
      // action surface.
      log.warn({ err: err.message, contactId: sig.contact_id }, 'contact liveness lookup failed; failing open to recency');
    }

    // (b) Linked engagement closed (archived) => not live. The signal has no
    //     direct engagement link; reach it via a human_task that already carries
    //     engagement_id for this signal. Best-effort.
    try {
      const e = await query(
        `SELECT e.status
           FROM inbox.human_tasks ht
           JOIN engagements.engagements e ON e.id = ht.engagement_id
          WHERE ht.signal_id = $1
            AND ht.deleted_at IS NULL
            AND ht.engagement_id IS NOT NULL
          ORDER BY ht.created_at DESC
          LIMIT 1`,
        [sig.id],
      );
      const status = e.rows[0]?.status;
      if (status === 'archived') {
        return { live: false, reason: 'engagement_archived' };
      }
    } catch (err) {
      // FAILS OPEN BY DESIGN (same rationale as the contact lookup above): a
      // transient error here must not block bridging. A SUCCESSFUL lookup
      // returning status='archived' still returns live=false above. Warn so a
      // sustained outage is visible.
      log.warn({ err: err.message, signalId: sig.id }, 'engagement liveness lookup failed; failing open to recency');
    }
  }

  // (c) RAG "superseded?" probe — behind a config flag, default OFF (cost).
  if (cfg?.ragSupersedeCheck) {
    // Stub (Phase 0). When enabled this would run a cheap RAG query against the
    // knowledge base to ask whether a later message superseded this obligation.
    // Intentionally a no-op until the flag is turned on and the probe is wired.
    log.debug({ signalId: sig.id }, 'ragSupersedeCheck enabled but probe is stubbed (Phase 0)');
  }

  // ---- FALLBACK: recency ---------------------------------------------------
  const now = Date.now();
  const dayMs = 86_400_000;

  if (sig.occurred_at) {
    const occurred = new Date(sig.occurred_at).getTime();
    if (Number.isFinite(occurred)) {
      const ageDays = (now - occurred) / dayMs;
      if (ageDays > staleness.occurredWithinDays) {
        return { live: false, reason: `stale_occurred_${Math.round(ageDays)}d` };
      }
    }
  }

  if (sig.due_date) {
    const due = new Date(sig.due_date).getTime();
    if (Number.isFinite(due)) {
      const overdueDays = (now - due) / dayMs;
      if (overdueDays > staleness.dueWithinDays) {
        return { live: false, reason: `stale_due_${Math.round(overdueDays)}d` };
      }
    }
  }

  return { live: true, reason: 'live' };
}

const TASK_TYPE_BY_SIGNAL = {
  action_item: 'action',
  commitment: 'action',
  request: 'request',
};

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str;
}

function titleFromContent(content) {
  return truncate(String(content || '').split('\n')[0].trim(), TITLE_CAP);
}

/**
 * Resolve a signal to an already-existing bridged work item: point this signal's
 * work_item_id at the winner so the loser is never orphaned (Linus blocker #4).
 * Best-effort; never throws.
 *
 * @param {Function} query
 * @param {string} signalId
 * @param {string} contentHash
 * @param {string} existingWorkItemId
 */
async function pointAtExisting(query, signalId, contentHash, existingWorkItemId) {
  try {
    await query(
      `UPDATE inbox.signals
          SET work_item_id = $2,
              content_hash = COALESCE(content_hash, $3)
        WHERE id = $1
          AND work_item_id IS NULL`,
      [signalId, existingWorkItemId, contentHash],
    );
  } catch (err) {
    log.warn({ err: err.message, signalId, existingWorkItemId }, 'failed to point loser signal at existing work item');
  }
}

/**
 * Bridge ONE signal into agent-actionable work.
 *
 * Order (matches the spec): load -> hash -> pre-claim dedup -> liveness ->
 * route -> (dryRun stamp | atomic claim -> create work_item -> gated human_task
 * -> stamp work_item_id/content_hash). On unique-index conflict, resolve to
 * already_bridged. A failure after the claim clears bridged_at so the row is
 * retryable (no claimed-but-unbridged orphan).
 *
 * @param {Object} opts
 * @param {Function} opts.query - pg-style (text, params) => { rows }
 * @param {string} opts.signalId - inbox.signals.id
 * @param {boolean} [opts.dryRun] - overrides config.dryRun when provided
 * @returns {Promise<{
 *   decision: 'dryrun'|'created'|'gated'|'already_bridged'|'skip'|'not_applicable',
 *   reason?: string,
 *   workItemId?: string|null,
 *   humanTaskId?: string|null,
 *   klass?: 'autonomous'|'gated',
 *   targetExecutor?: string|null,
 *   contentHash?: string,
 *   costUsd?: number,
 * }>}
 */
export async function bridgeSignal({ query, signalId, dryRun }) {
  if (!query || !signalId) throw new Error('bridgeSignal requires { query, signalId }');

  const cfg = routingConfig();
  const isDryRun = typeof dryRun === 'boolean' ? dryRun : !!cfg.dryRun;

  // (a) Load signal + channel + contact.
  //
  // OPT-154: inbox.signals.contact_id has never had a writer (column exists since
  // migration 127 but no code populates it), so isStillLive()'s contact branch was
  // always skipped and recency decided everything. We resolve the contact at LOAD
  // time by matching signal.contacts on the message sender address (lower()ed for
  // case-insensitive match) and pass its id/tier/metadata onto `sig` so the
  // context-primary liveness checks actually fire.
  //
  // LATERAL + LIMIT 1 (Linus blocker): email_address is UNIQUE only on exact case,
  // so lower()-folding can match two rows ('A@x.com' and 'a@x.com') and fan the
  // signal row out. The LATERAL collapses to at most one contact (most-recent
  // first, deterministic created_at tiebreak). Parameterized, no interpolation.
  const sigQ = await query(
    `SELECT s.id, s.message_id, s.signal_type, s.content, s.confidence,
            s.direction, s.domain, s.due_date, s.occurred_at,
            s.contact_id, s.work_item_id, s.bridged_at, s.owner_org_id,
            m.channel AS msg_channel,
            m.to_addresses AS msg_to_addresses,
            m.cc_addresses AS msg_cc_addresses,
            m.from_address AS msg_from_address,
            c.id       AS resolved_contact_id,
            c.tier     AS contact_tier,
            c.metadata AS contact_metadata
       FROM inbox.signals s
       LEFT JOIN inbox.messages m ON m.id = s.message_id
       LEFT JOIN LATERAL (
         SELECT id, tier, metadata
           FROM signal.contacts
          WHERE lower(email_address) = lower(m.from_address)
          ORDER BY created_at DESC NULLS LAST
          LIMIT 1
       ) c ON true
      WHERE s.id = $1`,
    [signalId],
  );
  if (sigQ.rows.length === 0) {
    return { decision: 'not_applicable', reason: 'signal_not_found', workItemId: null };
  }
  // OPT-154: prefer the stored signals.contact_id if a writer ever populates it,
  // otherwise use the contact resolved via the sender-address LATERAL. This is what
  // makes isStillLive()'s context-primary branch actually fire (contact_id was
  // perpetually NULL before). contact_tier / contact_metadata ride along. Build a
  // shallow copy rather than mutating the raw DB row (Linus minor).
  const sig = {
    ...sigQ.rows[0],
    contact_id: sigQ.rows[0].contact_id || sigQ.rows[0].resolved_contact_id || null,
  };

  if (!cfg.eligibleSignalTypes?.includes(sig.signal_type)) {
    return { decision: 'not_applicable', reason: 'ineligible_type', workItemId: null };
  }
  // Already bridged in a prior run?
  if (sig.work_item_id) {
    return { decision: 'already_bridged', reason: 'already_has_work_item', workItemId: sig.work_item_id };
  }

  // (a.5) DEFER TO THE LIVE PROMOTER (ADR-008 Phase 1 coordination, Liotta).
  //     Path A (signal-task-promoter → inbox.human_tasks) owns the HUMAN surface
  //     with relevance scoring the bridge lacks. If this signal already has a
  //     human_task, the promoter has it — the bridge creates NOTHING. This
  //     prevents double-carding (gated) and phantom autonomous execution of an
  //     obligation a human already owns/resolved. Predicate is symmetric with
  //     promoteSignal's own idempotence check (signal-task-promoter.js): defer on
  //     ANY non-deleted card, terminal or not. This app-level guard is retired in
  //     the end-state by a partial UNIQUE index on human_tasks(signal_id).
  const existingCard = await query(
    `SELECT id, status FROM inbox.human_tasks
      WHERE signal_id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [signalId],
  );
  if (existingCard.rows.length > 0) {
    return {
      decision: 'deferred_to_promoter',
      reason: 'human_task_exists',
      humanTaskId: existingCard.rows[0].id,
      workItemId: null,
    };
  }

  // (b) content_hash.
  const contentHash = computeContentHash(sig);

  // (c) PRE-CLAIM dedup — FAST PATH ONLY, not the lock. This SELECT cheaply
  //     short-circuits the common case (a re-ingested transcript whose
  //     obligation is already bridged or in-flight) before we do any work. It is
  //     NOT the at-most-once guarantee: two callers can both pass this SELECT.
  //     The real lock is the partial UNIQUE index
  //     (content_hash WHERE bridged_at IS NOT NULL) enforced by the claim UPDATE
  //     in (g) + its 23505 handler. Keyed on bridged_at so it also catches an
  //     in-flight winner (claimed, not yet stamped with work_item_id).
  const dup = await query(
    `SELECT id, work_item_id
       FROM inbox.signals
      WHERE content_hash = $1
        AND bridged_at IS NOT NULL
      LIMIT 1`,
    [contentHash],
  );
  if (dup.rows.length > 0) {
    const winnerWorkItemId = dup.rows[0].work_item_id;
    if (!isDryRun) {
      await pointAtExisting(query, signalId, contentHash, winnerWorkItemId);
    }
    return { decision: 'already_bridged', reason: 'content_hash_match', workItemId: winnerWorkItemId, contentHash };
  }

  // (d) Liveness — context-primary, recency-fallback.
  const liveness = await isStillLive({ query, sig, cfg });
  if (!liveness.live) {
    if (!isDryRun) {
      // Resolve the dead obligation so it stops surfacing. Record WHY.
      await query(
        `UPDATE inbox.signals
            SET resolved = true,
                resolved_at = now(),
                metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('resolution_reason', $2::text)
          WHERE id = $1
            AND resolved = false`,
        [signalId, `not_live:${liveness.reason}`],
      );
    }
    return { decision: 'skip', reason: `not_live:${liveness.reason}`, workItemId: null, contentHash };
  }

  // (d.5) CANARY: stale-cleanup-only (ADR-008 Phase 1 rollout). The first live
  //     flip drains the backlog's stale half (the not-live → resolve path above)
  //     but SUPPRESSES routing of live obligations — spawns no work_items and no
  //     cards — so nothing autonomous happens until the distribution is trusted.
  //     Dry-run is unaffected (it still reports the would-route split below).
  //     Flip staleCleanupOnly:false (ideally with a small batchSize) to begin
  //     routing live obligations. The signal is left unclaimed so it stays
  //     eligible once the canary ends.
  if (!isDryRun && (cfg.staleCleanupOnly ?? true)) {
    return { decision: 'route_suppressed_canary', reason: 'stale_cleanup_only', workItemId: null, contentHash };
  }

  // (e) Route (pure).
  const route = routeObligation(sig, cfg);

  // (f) Dry-run: stamp the would-be decision, create NOTHING.
  if (isDryRun) {
    await query(
      `UPDATE inbox.signals
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('bridge_dryrun', $2::jsonb)
        WHERE id = $1`,
      [
        signalId,
        JSON.stringify({
          klass: route.klass,
          target_executor: route.targetExecutor,
          route_reason: route.reason,
          liveness: liveness.reason,
          content_hash: contentHash,
          computed_at: new Date().toISOString(),
        }),
      ],
    );
    return {
      decision: 'dryrun',
      reason: route.reason,
      klass: route.klass,
      targetExecutor: route.targetExecutor,
      workItemId: null,
      contentHash,
      costUsd: 0,
    };
  }

  // (g) Atomic claim — exactly one caller wins the right to spawn. content_hash
  //     is written HERE (not in the late stamp) so the partial unique index
  //     (UNIQUE (content_hash) WHERE content_hash IS NOT NULL AND bridged_at IS
  //     NOT NULL) collides the loser BEFORE any work_item is created — no orphan
  //     (DBA race fix). On 23505 the row was claimed by a concurrent run with
  //     the same hash; resolve to the winner without creating anything.
  let claim;
  try {
    claim = await query(
      `UPDATE inbox.signals
          SET bridged_at = now(),
              content_hash = $2
        WHERE id = $1
          AND bridged_at IS NULL
        RETURNING id`,
      [signalId, contentHash],
    );
  } catch (err) {
    if (err && (err.code === '23505' || /duplicate key|unique/i.test(err.message || ''))) {
      const winner = await query(
        `SELECT id, work_item_id FROM inbox.signals
          WHERE content_hash = $1 AND bridged_at IS NOT NULL LIMIT 1`,
        [contentHash],
      ).catch(() => ({ rows: [] }));
      const winnerWorkItemId = winner.rows[0]?.work_item_id || null;
      return { decision: 'already_bridged', reason: 'content_hash_race', workItemId: winnerWorkItemId, contentHash };
    }
    throw err;
  }
  if (claim.rows.length === 0) {
    return { decision: 'already_bridged', reason: 'lost_claim_race', workItemId: sig.work_item_id || null, contentHash };
  }

  // From here: we hold the claim. Any failure must clear bridged_at so the row
  // is retryable rather than a claimed-but-unbridged orphan.
  let workItemId = null;
  let humanTaskId = null;
  try {
    const dataClassification = route.klass === 'gated' ? 'CONFIDENTIAL' : 'INTERNAL';
    const title = titleFromContent(sig.content);
    const description = truncate(sig.content, DESCRIPTION_CAP);
    const routeForExecutor = route.klass === 'autonomous' && !!route.targetExecutor;

    // OPT-162 Phase 2 (ADR-020): stamp the dedicated obligation/tenancy columns
    // added by mig 178 ON the work_item the bridge ALREADY creates. These are
    // INERT — nothing reads them until Phase 3 — so this changes no routing,
    // volume, or behavior; it only populates real columns alongside the existing
    // metadata (metadata.source_signal_id etc. stay).
    //
    //   owner_org_id   — copied from the SOURCE SIGNAL (set by mig 134). This
    //                    OVERRIDES mig 134's Staqs DEFAULT on work_items so a
    //                    multi-tenant obligation carries its real org. NULL signal
    //                    org → undefined → column omitted → DB DEFAULT (Staqs).
    //   obligation_type — mapped from sig.signal_type via the SHARED helper that
    //                    mirrors mig 178's backfill CASE (single source of truth).
    //   source_message_id — sig.message_id (denorm for the Phase 3 Today join).
    //   viewer_emails  — recipient set for htViewerFilter parity (see below).
    const stampOwnerOrgId = sig.owner_org_id || undefined;
    const stampObligationType = obligationTypeForSignal(sig.signal_type) || undefined;
    const stampSourceMessageId = sig.message_id || undefined;
    // viewer_emails mirrors the api.js htViewerFilter recipient-overlap set EXACTLY:
    // it tests (to_addresses || cc_addresses) and ONLY for channel='email'. We
    // denormalize that same set so a later phase's per-viewer filter matches what
    // the human_tasks Today query does today. Non-email / no-message obligations
    // carry no recipient addresses (htViewerFilter bypasses them), so leave the
    // column unset (undefined → DB DEFAULT NULL) rather than inventing a set.
    const recipientAddrs =
      sig.msg_channel === 'email'
        ? [
            ...(Array.isArray(sig.msg_to_addresses) ? sig.msg_to_addresses : []),
            ...(Array.isArray(sig.msg_cc_addresses) ? sig.msg_cc_addresses : []),
          ].filter((a) => typeof a === 'string' && a.length > 0)
        : [];
    const stampViewerEmails = recipientAddrs.length > 0 ? recipientAddrs : undefined;

    // ATOMIC SPAWN (Linus BLOCKER): work_item creation + gated card + signal
    // stamp + the durable task_routing event are ONE transaction. Previously
    // these were four separate ops (createWorkItem own-txn, gated INSERT, stamp,
    // a separate emit()). If the routing emit threw — a pre-129 CHECK violation
    // or a transient error — the work_item + stamp persisted with no routing
    // event: a silently-dropped orphan obligation. Now a throw anywhere rolls
    // the whole thing back (no orphan); the outer catch releases the claim so the
    // row stays retryable. The wake-up notify is fired AFTER commit (below).
    const txResult = await withTransaction(async (c) => {
      const item = await createWorkItem({
        type: 'task',
        title,
        description,
        createdBy: 'signal-action-bridge',
        // A-prime (ADR-008): the bridge NEVER sets assigned_to. assigned_to=NULL
        // bypasses the assignment trigger (enforce_assignment_rules first-checks
        // NULL) and fires NO task_assigned event. The orchestrator — the SOLE
        // assigner — picks up the task_routing event emitted below and assigns the
        // autonomous work_item to its target executor. Gated work is also created
        // unassigned; the human_task card (below) is what surfaces it.
        assignedTo: null,
        priority: 5,
        deadline: sig.due_date ? new Date(sig.due_date) : null,
        // NOTE: do NOT map the reversibility class onto routing_class — that column
        // is the execution-tier enum (DETERMINISTIC|LIGHTWEIGHT|FULL, 001-baseline
        // CHECK work_items_routing_class_check); 'autonomous'/'gated' violate it
        // (23514, surfaced by the Phase 1 live batch). Reversibility is carried in
        // metadata.reversibility_class below.
        // data_classification is set on the work_item at creation (before any
        // assignment can happen) so guard-check.js sees a gated item's CONFIDENTIAL
        // classification before any executor can claim it (Linus BLOCKER 1). Under
        // A-prime the bridge sets no assigned_to, so the only path to an executor
        // is the orchestrator acting on the task_routing event — by which point
        // the classification is long committed.
        dataClassification,
        // OPT-162 Phase 2: dedicated obligation/tenancy columns (mig 178). Each
        // is undefined when not derivable → createWorkItem omits the column →
        // DB DEFAULT applies (no behavior change). See derivation block above.
        ownerOrgId: stampOwnerOrgId,
        obligationType: stampObligationType,
        sourceMessageId: stampSourceMessageId,
        viewerEmails: stampViewerEmails,
        metadata: {
          source: 'signal-action-bridge',
          // email_id links the work_item to its originating inbox.messages row so the
          // context-loader (context-loader.js:133 reads metadata.email_id) can populate
          // context.email — without it, executor-ticket/executor-responder fail
          // "No email/message context" (every bridge work_item did, pre-fix). sig.message_id
          // IS inbox.messages.id (the bridge load query joins inbox.messages ON m.id=s.message_id).
          // Null for non-email-derived signals — those executors correctly skip with no context.
          email_id: sig.message_id || null,
          reversibility_class: route.klass,
          source_signal_id: signalId,
          signal_type: sig.signal_type,
          route_reason: route.reason,
          target_executor: route.targetExecutor,
          content_hash: contentHash,
          contact_id: sig.contact_id || null,
          data_classification: dataClassification,
        },
        // Run inside THIS transaction (no own txn) and skip its own post-commit
        // notify — createWorkItem honors `client` for exactly this.
        client: c,
      });
      const wid = item?.id || null;
      if (!wid) throw new Error('createWorkItem returned no id');

      // (i) Gated => create a VISIBLE board card. A blocked work_item alone is not
      //     surfaced to humans (guard-check.js only blocks AGENT CLAIM). Linus #1.
      let htId = null;
      if (route.klass === 'gated') {
        const ht = await c.query(
          `INSERT INTO inbox.human_tasks
             (signal_id, message_id, source_quote,
              title, description, due_date,
              task_type, status, next_action_hint,
              extraction_confidence, created_by, feedback_history)
           VALUES
             ($1, $2, $3,
              $4, $5, $6,
              $7, 'inbox', $8,
              $9, 'signal-action-bridge', $10::jsonb)
           RETURNING id`,
          [
            signalId,
            sig.message_id,
            sig.content,
            title,
            `Gated (irreversible: ${route.reason}). Board approval required before the send/commitment executes.`,
            sig.due_date ? new Date(sig.due_date).toISOString().slice(0, 10) : null,
            TASK_TYPE_BY_SIGNAL[sig.signal_type] || 'action',
            // No metadata column on human_tasks (schema verified) — carry the
            // work_item link in next_action_hint AND in feedback_history.
            `work_item:${wid}`,
            sig.confidence ?? null,
            JSON.stringify([
              {
                event: 'bridged_gated',
                work_item_id: wid,
                route_reason: route.reason,
                at: new Date().toISOString(),
              },
            ]),
          ],
        );
        htId = ht.rows[0]?.id || null;
      }

      // (j) Stamp work_item_id. content_hash was already written atomically in the
      //     claim (g), so the dedup race is closed before this point — no work_item
      //     can be orphaned by a late collision. This stamp only links the spawned
      //     item back to the signal.
      await c.query(
        `UPDATE inbox.signals
            SET work_item_id = $2
          WHERE id = $1`,
        [signalId, wid],
      );

      // (k) A-prime (ADR-008): for autonomous work bound for an executor, write a
      //     DURABLE task_routing INTENT event targeted at the orchestrator —
      //     INSIDE this transaction, so it commits atomically with the work_item
      //     and stamp (no orphaned obligation if a later step throws). The bridge
      //     has ZERO assignment authority — it only REQUESTS routing. The
      //     orchestrator (sole assigner, holds the executor grant rows) consumes
      //     this event and assigns the work_item, which stays assigned_to=NULL
      //     until it does. Gated work writes nothing here (its human_task card is
      //     the surface) and internal-only autonomous work (targetExecutor=null)
      //     needs no executor routing. The pg_notify wake-up is fired AFTER commit.
      if (routeForExecutor) {
        await c.query(
          `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
           VALUES ('task_routing', $1, 'orchestrator', $2, $3)`,
          [
            wid,
            5,
            JSON.stringify({
              target_executor: route.targetExecutor,
              source_signal_id: signalId,
            }),
          ],
        );
      }

      return { workItemId: wid, humanTaskId: htId };
    });

    workItemId = txResult.workItemId;
    humanTaskId = txResult.humanTaskId;

    // Post-commit wake-up ONLY (the durable row was inserted in-txn above). A
    // failed notify is harmless: the orchestrator's poll loop still picks up the
    // committed task_routing row. Best-effort — never poison the bridge result.
    if (routeForExecutor) {
      await notify({
        eventType: 'task_routing',
        workItemId,
        targetAgentId: 'orchestrator',
      }).catch(() => {});
    }

    log.info(
      { signalId, workItemId, humanTaskId, klass: route.klass, reason: route.reason },
      'signal bridged to work item',
    );

    return {
      decision: route.klass === 'gated' ? 'gated' : 'created',
      reason: route.reason,
      klass: route.klass,
      targetExecutor: route.targetExecutor,
      workItemId,
      humanTaskId,
      contentHash,
      costUsd: 0,
    };
  } catch (err) {
    // Defensive: the content_hash dedup race is now closed at the claim (g), so
    // a 23505 here should not originate from content_hash. Kept as a guard in
    // case any other unique constraint fires after the claim. Postgres unique
    // violation = SQLSTATE 23505.
    if (err && (err.code === '23505' || /duplicate key|unique/i.test(err.message || ''))) {
      // Roll back our claim (which set bridged_at + content_hash) and any partial
      // work_item link, then point at the winner if one exists.
      await query(
        `UPDATE inbox.signals SET bridged_at = NULL, content_hash = NULL, work_item_id = NULL WHERE id = $1`,
        [signalId],
      ).catch(() => {});
      const winner = await query(
        `SELECT work_item_id FROM inbox.signals
          WHERE content_hash = $1 AND bridged_at IS NOT NULL LIMIT 1`,
        [contentHash],
      ).catch(() => ({ rows: [] }));
      const winnerWorkItemId = winner.rows[0]?.work_item_id || null;
      if (winnerWorkItemId) {
        await pointAtExisting(query, signalId, contentHash, winnerWorkItemId);
      }
      return { decision: 'already_bridged', reason: 'unique_conflict', workItemId: winnerWorkItemId, contentHash };
    }

    // Any other failure: release the claim (bridged_at + content_hash were both
    // set in g) so the row is retryable. Do NOT leave a claimed-but-unbridged
    // orphan, and do NOT leave content_hash set on an unbridged row (it would
    // poison the dedup index against future legitimate bridging).
    log.error({ err: err.message, signalId, workItemId }, 'bridgeSignal failed after claim; releasing claim');
    await query(
      `UPDATE inbox.signals SET bridged_at = NULL, content_hash = NULL, work_item_id = NULL WHERE id = $1`,
      [signalId],
    ).catch((e) => log.error({ err: e.message, signalId }, 'failed to release bridge claim — manual recovery needed'));

    return { decision: 'not_applicable', reason: `error:${err.message}`, workItemId: null, contentHash };
  }
}
