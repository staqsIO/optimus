/**
 * surface-interrupt.js — OPT-48
 *
 * Wires the pure `routeSurface()` decision to live Telegram DMs.
 *
 * Design:
 *   - PURE routing lives in lib/runtime/signals/surface-router.js (no I/O there).
 *   - THIS module is the only place where a routing decision becomes a network call.
 *   - Per P2: the gate is an env-var check on TELEGRAM_BOT_TOKEN; nothing is sent
 *     when the token is absent (inert by default in staging/dev without a bot).
 *   - Per P4: boring infrastructure — one function, no framework.
 *
 * Owner → Telegram chat_id resolution:
 *   The `owner` field on a surface event is a board member handle (github_username).
 *   `agent_graph.board_members.telegram_id` carries that owner's Telegram chat ID.
 *   We query once per delivery and fall back to the env-var broadcast list when
 *   no per-owner row exists (same pattern as notifyCreator in sender.js).
 *
 * Quiet-hours + batch policy:
 *   routeSurface() already encodes the quiet-hours decision via the `quiet` context
 *   variable and the URGENCY_HORIZON_MS threshold. This module:
 *     - Delivers `telegram_dm` events immediately (surface-router already cleared them).
 *     - Queues everything else into `_batchQueue` which the daily-digest scheduler
 *       can drain via `flushBatchQueue()` / `drainBatchQueue()`.
 *   This means we NEVER reimplement quiet-hours logic here — we trust the router.
 *
 * Gate (inert without a configured bot):
 *   if (!process.env.TELEGRAM_BOT_TOKEN) → log and return early; no send attempt.
 *
 * Usage (called from event producers / scheduler):
 *   import { deliverSurfaceEvent, drainBatchQueue } from './surface-interrupt.js';
 *
 *   // On a new governance event:
 *   await deliverSurfaceEvent(event, { quietHours, ownerPrefs });
 *
 *   // In the daily-digest scheduler (to flush batched non-urgent items):
 *   const lines = drainBatchQueue();
 *   if (lines.length) await notifyBoard('Batched items:\n' + lines.join('\n'));
 */

import { routeSurface, SURFACES } from '../../../lib/runtime/signals/surface-router.js';
import { sendMessage } from './client.js';
import { query } from '../db.js';

// ---------------------------------------------------------------------------
// Batch queue for non-urgent, non-DM events (drained by daily-digest)
// ---------------------------------------------------------------------------

/** @type {Array<{event: object, reason: string, ts: Date}>} */
const _batchQueue = [];

/**
 * Add an event to the batch queue (will be included in the next daily digest).
 * @param {object} event
 * @param {string} reason - routing reason from routeSurface
 */
export function queueForBatch(event, reason) {
  _batchQueue.push({ event, reason, ts: new Date() });
}

/**
 * Drain and return the current batch queue entries as human-readable lines,
 * then clear the queue. Call this from the daily-digest scheduler.
 * @returns {string[]}
 */
export function drainBatchQueue() {
  const lines = _batchQueue.map(({ event, reason, ts }) => {
    const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const owner = event.owner ? ` [@${event.owner}]` : '';
    return `  [${timeStr}]${owner} ${event.type || 'event'}: ${event.summary || event.description || reason}`;
  });
  _batchQueue.length = 0;
  return lines;
}

/**
 * Current batch queue length (for health checks / tests).
 * @returns {number}
 */
export function batchQueueSize() {
  return _batchQueue.length;
}

// ---------------------------------------------------------------------------
// Owner → Telegram chat_id resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Telegram chat_id for a given owner handle (github_username).
 * Returns null if not found (caller falls back to broadcast).
 *
 * @param {string} ownerHandle - github_username of the board member
 * @returns {Promise<string|null>}
 */
async function resolveTelegramChatId(ownerHandle) {
  if (!ownerHandle) return null;
  try {
    const result = await query(
      `SELECT telegram_id FROM agent_graph.board_members WHERE github_username = $1 LIMIT 1`,
      [ownerHandle]
    );
    const row = result.rows[0];
    return row?.telegram_id ?? null;
  } catch (err) {
    console.warn(`[surface-interrupt] Could not resolve telegram_id for owner "${ownerHandle}": ${err.message}`);
    return null;
  }
}

/**
 * Broadcast to TELEGRAM_BOARD_USER_IDS (env fallback, same as notifyBoard in sender.js).
 * @param {string} text
 */
async function broadcastFallback(text) {
  const raw = process.env.TELEGRAM_BOARD_USER_IDS || '';
  const userIds = raw.split(',').map(id => id.trim()).filter(Boolean);
  if (userIds.length === 0) {
    console.warn('[surface-interrupt] No TELEGRAM_BOARD_USER_IDS set for broadcast fallback');
    return;
  }
  await Promise.allSettled(userIds.map(chatId => sendMessage(chatId, text)));
}

// ---------------------------------------------------------------------------
// Format a surface event as a Telegram DM
// ---------------------------------------------------------------------------

/**
 * Compose a compact Telegram DM text from a surface event.
 * Keeps it human-readable; never includes raw JSON.
 * @param {object} event
 * @param {string} reason - routing reason from surface-router
 * @returns {string}
 */
function formatDM(event, reason) {
  const lines = [];

  // Header: event type → emoji mapping
  const typeEmoji = {
    gated_approval: '🔐',
    gate_failure: '🚫',
    draft_ready: '📝',
    task_blocked: '⛔',
    obligation_due: '📌',
    task_progress: '📊',
  };
  const emoji = typeEmoji[event.type] || '📬';
  const title = event.title || event.summary || event.type || 'Event';
  lines.push(`${emoji} ${title}`);

  // Summary / description
  if (event.description && event.description !== title) {
    lines.push(event.description);
  }

  // Decision deadline countdown for gated approvals
  if (event.decisionDeadline) {
    const deadline = new Date(event.decisionDeadline);
    const msUntil = deadline.getTime() - Date.now();
    if (msUntil > 0) {
      const hoursUntil = Math.round(msUntil / (60 * 60 * 1000));
      lines.push(`⏰ Decision deadline: ${hoursUntil}h`);
    } else {
      lines.push(`⚠️ Decision deadline PASSED`);
    }
  }

  // Routing context (for auditability, P3)
  if (reason === 'quiet_hours_urgent_override') {
    lines.push('(Urgent — interrupting quiet hours)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Route a surface event and deliver it if the router says `telegram_dm`.
 * Everything else is either queued for batch or silent_log (no action here).
 *
 * **Gate**: returns immediately (inert) if `TELEGRAM_BOT_TOKEN` is not set.
 *
 * @param {object} event - structured surface event (see surface-router contract)
 * @param {object} [options]
 * @param {Date}   [options.now]          - injectable clock
 * @param {object} [options.quietHours]   - global quiet-hours config
 * @param {object} [options.ownerPrefs]   - per-owner prefs (quietHours, telegramOptOut)
 * @returns {Promise<{ surface: string, owner: string|null, reason: string, delivered: boolean }>}
 */
export async function deliverSurfaceEvent(event, options = {}) {
  // ── Gate: inert without a configured Telegram bot ──────────────────────
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.debug('[surface-interrupt] TELEGRAM_BOT_TOKEN not set — skipping surface event delivery');
    return { surface: SURFACES.SILENT_LOG, owner: null, reason: 'telegram_not_configured', delivered: false };
  }

  // ── Route ───────────────────────────────────────────────────────────────
  const { surface, owner, reason } = routeSurface(event, options);

  // ── Dispatch ─────────────────────────────────────────────────────────────
  if (surface === SURFACES.TELEGRAM_DM) {
    const text = formatDM(event, reason);
    let delivered = false;

    // Try per-owner DM first
    const chatId = await resolveTelegramChatId(owner);
    if (chatId) {
      try {
        await sendMessage(chatId, text);
        console.log(`[surface-interrupt] DM sent to @${owner} (chat ${chatId}) — ${reason}`);
        delivered = true;
      } catch (err) {
        console.error(`[surface-interrupt] Failed to DM @${owner}: ${err.message}`);
      }
    }

    // Fall back to broadcast if per-owner delivery failed or no chat_id
    if (!delivered) {
      try {
        await broadcastFallback(text);
        console.log(`[surface-interrupt] Broadcast fallback sent — ${reason}`);
        delivered = true;
      } catch (err) {
        console.error(`[surface-interrupt] Broadcast fallback failed: ${err.message}`);
      }
    }

    return { surface, owner, reason, delivered };
  }

  // Non-DM surfaces: queue for batch (will surface in daily digest)
  // silent_log events are not queued (they're truly ambient)
  if (surface !== SURFACES.SILENT_LOG) {
    queueForBatch(event, reason);
    console.debug(`[surface-interrupt] Queued for batch — ${reason} (${surface})`);
  } else {
    console.debug(`[surface-interrupt] Silent log — ${reason}`);
  }

  return { surface, owner, reason, delivered: false };
}

export default deliverSurfaceEvent;
