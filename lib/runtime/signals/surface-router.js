/**
 * Surface Router — OPT-50, the keystone "alive mechanics" primitive.
 *
 * ONE deterministic router. Many surfaces are fed by one event stream, but
 * per-event spam is OUT: only owner-actionable items interrupt; everything
 * else goes to `silent_log` (the morning brief / activity feed carries it).
 *
 * Design principles:
 *   P2 — Infrastructure enforces; prompts advise. Routing is decided ONLY
 *        from STRUCTURED fields (event type, owner, a structural
 *        importance/actionability signal, an explicit urgency/deadline,
 *        quiet-hours window). It NEVER reads message content with an LLM and
 *        NEVER infers a surface from free text. The routing decision is a
 *        deterministic table, not a model call.
 *   P3 — Transparency by structure. Every decision carries a machine-readable
 *        `reason` so the route is auditable without re-running anything.
 *   P4 — Boring infrastructure. Plain JS, a static table, pure arithmetic on
 *        the clock. No I/O, no DB, no network — trivially testable.
 *
 * This module is PURE and side-effect-free. It does not import senders and
 * does not touch the DB. Wiring the chosen surface into live senders is
 * OPT-48 / OPT-46; this module only decides *which* surface and *why*.
 *
 * ---------------------------------------------------------------------------
 * Contract
 * ---------------------------------------------------------------------------
 * routeSurface(event, { now, quietHours, ownerPrefs }) -> { surface, owner, reason }
 *
 *   event: {
 *     type:            string   // structural event type (see EVENT_TYPES)
 *     owner:           string|null  // board member handle/id the event is for
 *     importance?:     'low'|'normal'|'high'|'critical'  // structural rank
 *     actionable?:     boolean  // is the OWNER expected to act? (structural)
 *     scope?:          'owner'|'project'|'channel'|'org'|'ambient'
 *     urgent?:         boolean  // structural urgency flag (e.g. gated approval)
 *     decisionDeadline?: Date|string|number|null  // ADR-011: imminent decision
 *   }
 *   options: {
 *     now?:        Date           // injectable clock (defaults to new Date())
 *     quietHours?: { start, end, timezoneOffsetMinutes? } | null
 *     ownerPrefs?: { quietHours?, telegramOptOut?, ... }  // per-owner overrides
 *   }
 *
 * Returns exactly one surface:
 *   SURFACES.TELEGRAM_DM       — owner-actionable, high importance, interrupt
 *   SURFACES.SLACK_CHANNEL     — project/channel-scoped progress
 *   SURFACES.WORKSTATION_CARD  — ambient "what moved" (board feed)
 *   SURFACES.SILENT_LOG        — everything else / quiet-hours non-urgent
 */

/** @enum {string} The four (and only four) surfaces. */
export const SURFACES = Object.freeze({
  TELEGRAM_DM: 'telegram_dm',
  SLACK_CHANNEL: 'slack_channel',
  WORKSTATION_CARD: 'workstation_card',
  SILENT_LOG: 'silent_log',
});

/** Importance ranks, ordered low→critical. */
export const IMPORTANCE = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

/**
 * Structural event types the router understands. Unknown types are NOT an
 * error — they fall through to the default by their structural fields. This
 * list documents the well-known producers (one event stream, many surfaces).
 * @enum {string}
 */
export const EVENT_TYPES = Object.freeze({
  GATED_APPROVAL: 'gated_approval',        // governance queue — board must decide
  GATE_FAILURE: 'gate_failure',            // constitutional gate blocked an action
  DRAFT_READY: 'draft_ready',              // a draft awaits owner approval
  TASK_BLOCKED: 'task_blocked',            // a task needs owner unblock
  TASK_PROGRESS: 'task_progress',          // project/channel progress update
  CAMPAIGN_PROGRESS: 'campaign_progress',  // campaign step completed
  BUILD_RESULT: 'build_result',            // coder build finished (project-scoped)
  SIGNAL_DETECTED: 'signal_detected',      // ambient signal captured
  ARTIFACT_ENRICHED: 'artifact_enriched',  // ambient enrichment moved something
  ENGAGEMENT_MOVED: 'engagement_moved',    // pipeline state changed (ambient)
  HEARTBEAT: 'heartbeat',                  // cron liveness — never interrupts
});

const HIGH = IMPORTANCE.high;

/** Quiet-hours can only be pierced by a decision due within this horizon. */
export const URGENCY_HORIZON_MS = 6 * 60 * 60 * 1000; // 6 hours

function parseDeadline(d) {
  if (d == null) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.getTime();
  if (typeof d === 'number') return Number.isFinite(d) ? d : null;
  if (typeof d === 'string') {
    const t = Date.parse(d);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Is the structural urgency strong enough to pierce quiet hours?
 *
 * Per ADR-011: a gated approval with an imminent decision_deadline is the
 * highest-signal interrupt source. Urgency is taken from STRUCTURED fields
 * only — an explicit `urgent` flag, or a `decisionDeadline` that lands within
 * (or has already passed) the urgency horizon. Never inferred from content.
 *
 * @param {object} event
 * @param {Date} now
 * @returns {boolean}
 */
export function isUrgent(event, now) {
  if (!event) return false;
  if (event.urgent === true) return true;
  const deadline = parseDeadline(event.decisionDeadline);
  if (deadline == null) return false;
  // Imminent = deadline within the horizon. A deadline already past is
  // escalated too (the decision is overdue).
  const msUntil = deadline - now.getTime();
  return msUntil <= URGENCY_HORIZON_MS;
}

/**
 * Is `now` inside the quiet-hours window? Supports same-day windows
 * (start < end, e.g. 1→5) and overnight wraparound (start > end, e.g. 22→7).
 * A null/equal window means "no quiet hours".
 *
 * @param {Date} now
 * @param {{start:number,end:number,timezoneOffsetMinutes?:number}|null} quietHours
 * @returns {boolean}
 */
export function inQuietHours(now, quietHours) {
  if (!quietHours) return false;
  const { start, end, timezoneOffsetMinutes } = quietHours;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start === end) return false; // empty / disabled window

  // Resolve the local hour. If an explicit offset is provided we shift the
  // UTC clock by it; otherwise we use the host's local hour. (No I/O — pure.)
  let hour;
  if (Number.isInteger(timezoneOffsetMinutes)) {
    const shifted = new Date(now.getTime() + timezoneOffsetMinutes * 60 * 1000);
    hour = shifted.getUTCHours();
  } else {
    hour = now.getHours();
  }

  if (start < end) {
    // Same-day window, e.g. [1, 5): 1,2,3,4 are quiet.
    return hour >= start && hour < end;
  }
  // Overnight wraparound, e.g. [22, 7): 22,23,0..6 are quiet.
  return hour >= start || hour < end;
}

/**
 * The deterministic routing table. Each rule is evaluated in order; the FIRST
 * match wins. Predicates read ONLY structured fields — there is no content
 * inspection and no model call anywhere in this file.
 *
 * Returns { surface, reason }. `owner` is attached by routeSurface.
 *
 * @param {object} event
 * @param {{ urgent: boolean, quiet: boolean, importance: number, actionable: boolean, scope: string }} ctx
 */
function decide(event, ctx) {
  const { urgent, quiet, importance, actionable, scope } = ctx;

  // ── Rule 0: Quiet hours demote everything that is not truly urgent. ──
  // During quiet hours only a structurally-urgent, owner-actionable item
  // (e.g. a gated approval with an imminent decision_deadline) may still
  // interrupt via Telegram. Everything else batches into the morning brief.
  if (quiet) {
    if (urgent && actionable && event.owner) {
      return { surface: SURFACES.TELEGRAM_DM, reason: 'quiet_hours_urgent_override' };
    }
    return { surface: SURFACES.SILENT_LOG, reason: 'quiet_hours_demoted' };
  }

  // ── Rule 1: Owner-actionable + high importance → interrupt via Telegram. ──
  if (actionable && event.owner && importance >= HIGH) {
    return { surface: SURFACES.TELEGRAM_DM, reason: 'owner_actionable_high_importance' };
  }

  // ── Rule 2: Structurally urgent owner item, even if not flagged high. ──
  // (Urgency implies it warrants the interrupt regardless of the rank label.)
  if (urgent && actionable && event.owner) {
    return { surface: SURFACES.TELEGRAM_DM, reason: 'owner_actionable_urgent' };
  }

  // ── Rule 3: Project/channel-scoped progress → Slack channel. ──
  if (scope === 'project' || scope === 'channel') {
    return { surface: SURFACES.SLACK_CHANNEL, reason: 'project_channel_progress' };
  }

  // ── Rule 4: Ambient "what moved" → Workstation card (board feed). ──
  // Owner-relevant-but-not-actionable, or org/ambient-scoped movement that is
  // still worth a glance, surfaces as a non-interrupting card.
  if (scope === 'ambient' || scope === 'org' || (event.owner && !actionable)) {
    return { surface: SURFACES.WORKSTATION_CARD, reason: 'ambient_what_moved' };
  }

  // ── Rule 5 (default): everything else → silent log. ──
  // The morning brief / activity feed carries it; no surface interrupts.
  return { surface: SURFACES.SILENT_LOG, reason: 'default_silent_log' };
}

/**
 * Normalize an importance value (string or number) into a numeric rank.
 * Unknown / missing → normal.
 * @param {string|number|undefined} importance
 * @returns {number}
 */
function rankImportance(importance) {
  if (typeof importance === 'number' && Number.isFinite(importance)) {
    return importance;
  }
  if (typeof importance === 'string' && importance in IMPORTANCE) {
    return IMPORTANCE[importance];
  }
  return IMPORTANCE.normal;
}

/**
 * Resolve the effective quiet-hours window: per-owner preference overrides the
 * global window. Pure — just picks one of the two structured objects.
 */
function resolveQuietHours(quietHours, ownerPrefs) {
  if (ownerPrefs && ownerPrefs.quietHours !== undefined) {
    return ownerPrefs.quietHours; // may be null to explicitly disable
  }
  return quietHours ?? null;
}

/**
 * Route a single structured event to exactly one surface.
 *
 * PURE and DETERMINISTIC: identical (event, options) always yields the
 * identical result. No I/O, no clock read except the injected `now`, no model.
 *
 * @param {object} event   structured event (see file header for shape)
 * @param {object} [options]
 * @param {Date}   [options.now]        injected clock (defaults to new Date())
 * @param {{start:number,end:number,timezoneOffsetMinutes?:number}|null} [options.quietHours]
 * @param {object} [options.ownerPrefs] per-owner overrides (quietHours, telegramOptOut)
 * @returns {{ surface: string, owner: string|null, reason: string }}
 */
export function routeSurface(event, options = {}) {
  if (!event || typeof event !== 'object') {
    return { surface: SURFACES.SILENT_LOG, owner: null, reason: 'invalid_event' };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const ownerPrefs = options.ownerPrefs || null;
  const effectiveQuietHours = resolveQuietHours(options.quietHours, ownerPrefs);

  const owner = event.owner ?? null;
  const importance = rankImportance(event.importance);
  const actionable = event.actionable === true;
  const scope = typeof event.scope === 'string' ? event.scope : 'ambient';
  const urgent = isUrgent(event, now);
  const quiet = inQuietHours(now, effectiveQuietHours);

  const ctx = { urgent, quiet, importance, actionable, scope };
  const { surface, reason } = decide(event, ctx);

  // Per-owner opt-out: an owner who has muted Telegram never gets a DM; the
  // item demotes to a non-interrupting card so it is still visible. This is a
  // structural preference, not content inference.
  if (
    surface === SURFACES.TELEGRAM_DM &&
    ownerPrefs &&
    ownerPrefs.telegramOptOut === true
  ) {
    return { surface: SURFACES.WORKSTATION_CARD, owner, reason: reason + '__telegram_opt_out' };
  }

  return { surface, owner, reason };
}

export default routeSurface;
