/**
 * Human-in-the-Loop (HITL) contract layer (ADR-024)
 *
 * Provides awaitHumanInput() for agents to pause a campaign, store a question,
 * and block until an operator submits an answer via the board dashboard.
 *
 * Resume path: operator POSTs /api/campaigns/:id/hitl/:requestId/respond →
 *   DB updated → pg_notify('hitl_resolved', {requestId, answer}) → Promise resolves.
 *
 * Fallback: if pg LISTEN unavailable (PGlite), polls every 2s until answer arrives.
 */

import { query, getPool } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { createLogger } from '../logger.js';
const log = createLogger('hitl/index');

const HITL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours — board members aren't watching in real-time
const POLL_INTERVAL_MS = 30_000; // 30s between polls (pg_notify handles instant wakeup)

/**
 * Pause a campaign and wait for operator input.
 *
 * @param {string} campaignId
 * @param {string} question  - The clarifying question for the operator
 * @param {string} [agentId]
 * @returns {Promise<string>} Resolves with the operator's answer string
 */
export async function awaitHumanInput(campaignId, question, agentId = 'claw-campaigner') {
  // 1. Insert HITL request record
  const r = await query(
    `INSERT INTO agent_graph.campaign_hitl_requests (campaign_id, agent_id, question)
     VALUES ($1, $2, $3) RETURNING id`,
    [campaignId, agentId, question]
  );
  const requestId = r.rows[0].id;

  // 2. Pause campaign — operators see this on the dashboard immediately
  await query(
    `UPDATE agent_graph.campaigns
     SET campaign_status = 'awaiting_input', updated_at = now()
     WHERE id = $1`,
    [campaignId]
  );

  await publishEvent(
    'campaign_awaiting_input',
    `Campaign ${campaignId} awaiting human input`,
    agentId,
    null,
    { campaign_id: campaignId, request_id: requestId, question }
  ).catch(() => {});

  log.info(`Campaign ${campaignId} paused — awaiting operator answer (request ${requestId})`);

  // 3. Wait: LISTEN/NOTIFY primary, polling fallback
  return _waitForAnswer(requestId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _waitForAnswer(requestId) {
  const pool = getPool();

  if (!pool) {
    // PGlite / test mode — polling only
    return _pollForAnswer(requestId);
  }

  return new Promise((resolve, reject) => {
    let client = null;
    let settled = false;
    let pollTimer = null; // Linus: hoist so _cleanup can clear it

    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      _cleanup(client);
      reject(new Error(`HITL timeout: no operator response after ${HITL_TIMEOUT_MS / 1000}s`));
    }, HITL_TIMEOUT_MS);

    function _cleanup(c) {
      clearTimeout(deadline);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (c) {
        c.query('UNLISTEN hitl_resolved').catch(() => {});
        c.release();
      }
    }

    // NOTE [OPT-114]: under the Supabase TRANSACTION pooler (port 6543), this
    // LISTEN silently becomes a no-op — PgBouncer releases the backend after the
    // LISTEN statement's transaction, so the subscription evaporates and the
    // notification handler never fires. That is acceptable: the 2s polling
    // backstop below catches every resolution (no data loss, verified). To
    // restore push-delivery, route this through lib/runtime/pg-listener.js on the
    // session pooler (5432) like the Phase-1 subscribers.
    pool.connect()
      .then((c) => {
        client = c;
        return client.query('LISTEN hitl_resolved');
      })
      .then(() => {
        // Handler fires when ANY hitl_resolved notification arrives
        client.on('notification', (msg) => {
          if (settled) return;
          try {
            const payload = JSON.parse(msg.payload);
            if (payload.requestId === requestId) {
              settled = true;
              _cleanup(client);
              client = null;
              resolve(payload.answer);
            }
          } catch {
            // malformed payload — ignore, keep waiting
          }
        });

        // Safety: also poll every 2s in case we miss a notification (e.g. reconnect)
        pollTimer = setInterval(async () => {
          if (settled) { clearInterval(pollTimer); pollTimer = null; return; }
          try {
            const row = await query(
              `SELECT answer, status FROM agent_graph.campaign_hitl_requests WHERE id = $1`,
              [requestId]
            );
            if (row.rows[0]?.status === 'resolved') {
              settled = true;
              _cleanup(client);
              client = null;
              resolve(row.rows[0].answer);
            }
          } catch { /* ignore poll errors */ }
        }, POLL_INTERVAL_MS);
      })
      .catch((err) => {
        // LISTEN unavailable — fall back to pure polling
        log.warn(`LISTEN failed (${err.message}), falling back to polling`);
        if (client) { client.release(); client = null; }
        clearTimeout(deadline);
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        _pollForAnswer(requestId, HITL_TIMEOUT_MS).then(resolve, reject);
      });
  });
}

async function _pollForAnswer(requestId, timeoutMs = HITL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const result = await query(
      `SELECT answer, status FROM agent_graph.campaign_hitl_requests WHERE id = $1`,
      [requestId]
    ).catch(() => null);

    if (result?.rows[0]?.status === 'resolved') {
      return result.rows[0].answer;
    }
  }

  throw new Error(`HITL timeout: no operator response after ${timeoutMs / 1000}s`);
}
