/**
 * Weekly recap on-demand trigger (temporary test endpoint).
 *
 * Auth: covered by the global api.js auth guard (Bearer INBOX_API_SECRET or board JWT).
 * Live sends require `confirm: true` in the body — guard against accidental POSTs.
 */

import { query } from '../db.js';
import { sendWeeklyRecaps } from '../signal/weekly-recap.js';

async function resolveRecipient(email) {
  const { rows } = await query(
    `SELECT a.id AS account_id, a.identifier, a.label, a.owner_id,
            bm.display_name
       FROM inbox.accounts a
       LEFT JOIN agent_graph.board_members bm ON bm.id = a.owner_id
      WHERE a.channel = 'email' AND a.is_active = true
        AND lower(a.identifier) = lower($1)
      LIMIT 1`,
    [email]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    email,
    displayName: r.display_name || r.label || email,
    accountId: r.account_id,
    memberId: r.owner_id || null,
  };
}

export function registerWeeklyRecapRoutes(routes) {
  // POST /api/weekly-recap/run
  //   { email?: string, windowDays?: number, dryRun?: boolean, confirm?: boolean }
  // Defaults: windowDays=7, dryRun=true. If dryRun=false, confirm:true is required.
  routes.set('POST /api/weekly-recap/run', async (_req, body = {}) => {
    const email = body.email || 'carlos@staqs.io';
    const windowDays = Number.isFinite(body.windowDays) ? Number(body.windowDays) : 7;
    const dryRun = body.dryRun !== false;  // default true

    if (!dryRun && body.confirm !== true) {
      return { error: 'Live send requires "confirm": true in the request body' };
    }

    const recipient = await resolveRecipient(email);
    if (!recipient) {
      return { error: `No active Gmail account found for ${email}` };
    }

    const result = await sendWeeklyRecaps({
      now: new Date(),
      windowDays,
      overrideRecipients: [recipient],
      dryRun,
    });

    return {
      ok: true,
      mode: dryRun ? 'dry-run' : 'live',
      recipient: { email: recipient.email, accountId: recipient.accountId },
      ...result,
    };
  });
}
