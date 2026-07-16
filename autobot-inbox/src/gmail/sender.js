import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';
import { createDraft } from './client.js';
import { query } from '../db.js';
import { logCommsIntent, publishEvent } from '../runtime/infrastructure.js';

/**
 * Gmail sender: creates drafts (L0) or sends emails (L1+).
 * D2: In L0, ALWAYS create drafts, never send directly.
 * G5: Reversibility — drafts are reversible, sends are not.
 */

/**
 * Create a Gmail draft for a reviewed+approved draft.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Gmail draft ID
 */
export async function createGmailDraft(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  // Get the original email for threading
  const emailResult = await query(`SELECT * FROM inbox.messages WHERE id = $1`, [draft.message_id]);
  const email = emailResult.rows[0];

  const body = draft.board_edited_body || draft.body;
  const to = draft.to_addresses[0];
  const subject = draft.subject || `Re: ${email?.subject || ''}`;

  const gmailDraftId = await createDraft(
    to,
    subject,
    body,
    email?.thread_id || null,
    email?.message_id || null,
    draft.account_id || null
  );

  // Update draft record.
  // Preserve the 'sending' lock: when createGmailDraft is called from inside a
  // claimed sendApprovedDraft (send_state='sending'), do NOT downgrade to
  // 'staged' — doing so would reopen the atomic-claim window and allow a
  // concurrent caller to re-claim and double-send. Pre-send callers (row is
  // null/'staged') still get 'staged' as before.
  await query(
    `UPDATE agent_graph.action_proposals
     SET provider_draft_id = $1,
         send_state = CASE WHEN send_state = 'sending' THEN send_state ELSE 'staged' END,
         updated_at = now()
     WHERE id = $2`,
    [gmailDraftId, draftId]
  );

  // Shadow log the communication intent (autobot_comms)
  await logCommsIntent({ channel: 'email', recipient: to, subject, body, intentType: 'draft', sourceAgent: 'executor-responder', sourceTask: draftId });
  await publishEvent('draft_created', `Gmail draft created for ${draftId}`, null, null, { draft_id: draftId });

  console.log(`[sender] Gmail draft created: ${gmailDraftId} for draft ${draftId}`);
  return gmailDraftId;
}

/**
 * Send a Gmail draft (L1+ only, for auto-send after autonomy checks).
 *
 * ⚠️ #498 AI-DISCLOSURE COMPLIANCE — READ BEFORE WIRING THIS PATH.
 * This is the (currently unreferenced) autonomous send path: no board member is
 * in the loop, so a delivered row here has `board_action IS NULL`. Board policy
 * (2026-07-05): autonomously-released messages MUST carry AI-disclosure text
 * (board-reviewed sends do not). Two things are required before this can deliver:
 *   1. Append the channel disclosure to the outgoing body BEFORE the Gmail draft
 *      is assembled (Gmail sends a pre-baked draft object by id, so the text must
 *      go in at createGmailDraft time, not here) — reuse the fail-closed
 *      getAiDisclosure()/AI_DISCLOSURE_FALLBACK (lib/comms/gateway.js).
 *   2. Relax the baseline constraint
 *      `CHECK (send_state != 'delivered' OR board_action IS NOT NULL)` that
 *      currently blocks autonomous delivery. Doing (2) without (1) trips
 *      test/disclosure-autonomous-tripwire.test.js. See GitHub issue #498.
 *
 * @param {string} draftId - Database draft ID
 */
export async function sendDraft(draftId) {
  const level = parseInt(process.env.AUTONOMY_LEVEL || '0', 10);
  if (level < 1) {
    throw new Error('sendDraft() requires autonomy level >= 1 (L1). Current: L0. Use sendApprovedDraft() for board-approved drafts.');
  }

  // Atomic claim: prevent double-send race (same lock as sendApprovedDraft,
  // #489). The L1+ auto-send path has NO human in the loop, so an unguarded
  // re-entry (retry, concurrent poll tick) would double-send. send_state =
  // 'sending' is the lock — only one caller can claim; provider_sent_id IS NULL
  // prevents re-sending an already-delivered draft (#493).
  const claimed = await query(
    `UPDATE agent_graph.action_proposals
     SET send_state = 'sending', updated_at = now()
     WHERE id = $1 AND provider_sent_id IS NULL AND send_state != 'sending'
     RETURNING id, provider_draft_id, account_id`,
    [draftId]
  );
  if (claimed.rowCount === 0) {
    throw new Error(`Draft ${draftId} already sending or sent`);
  }
  const draft = claimed.rows[0];

  if (!draft.provider_draft_id) {
    // Release the claim — nothing to send.
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'staged', updated_at = now() WHERE id = $1`,
      [draftId]
    );
    throw new Error(`No Gmail draft for ${draftId}`);
  }

  // Only the send itself is in the release-on-failure region: if the Gmail send
  // throws, nothing went out, so revert to 'staged' for retry. Once send()
  // succeeds the email is irreversibly out — we must NEVER release the claim
  // past this point, or a retry would re-claim and re-send (#536 Linus V-5).
  let sendResult;
  try {
    const auth = draft.account_id ? await getAuthForAccount(draft.account_id) : getAuth();
    const gmailClient = google.gmail({ version: 'v1', auth });
    sendResult = await gmailClient.users.drafts.send({
      userId: 'me',
      requestBody: { id: draft.provider_draft_id },
    });
  } catch (err) {
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'staged', updated_at = now() WHERE id = $1`,
      [draftId]
    );
    throw err;
  }

  // Send SUCCEEDED. Persist the delivered state. If THIS fails (DB blip), do NOT
  // release: the row stays send_state='sending' with provider_sent_id NULL,
  // which the claim guard blocks from re-claiming → no duplicate send. Log
  // loudly for manual reconciliation (the email is out; the record isn't).
  try {
    await query(
      `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
       WHERE id = $2`,
      [sendResult.data.id, draftId]
    );
  } catch (persistErr) {
    console.error(
      `[sender] CRITICAL: draft ${draftId} was SENT (gmail id ${sendResult.data.id}) but the delivered-state persist failed. Row left locked in 'sending' to prevent re-send; reconcile manually.`,
      persistErr
    );
    throw persistErr;
  }

  console.log(`[sender] Email sent: ${sendResult.data.id} for draft ${draftId}`);
  return sendResult.data.id;
}

/**
 * Send a board-approved draft. Board approval IS the L0 human check,
 * so this works at any autonomy level.
 * Flow: verify board_action → create Gmail draft if needed → send → update state.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Gmail sent message ID
 */
export async function sendApprovedDraft(draftId) {
  // Atomic claim: prevent double-send race condition.
  // Uses send_state = 'sending' as a lock — only one caller can claim.
  const claimed = await query(
    `UPDATE agent_graph.action_proposals
     SET send_state = 'sending', updated_at = now()
     WHERE id = $1 AND provider_sent_id IS NULL AND send_state != 'sending'
     RETURNING id, board_action, provider_draft_id, account_id, to_addresses, subject, board_edited_body, body`,
    [draftId]
  );
  if (claimed.rowCount === 0) {
    throw new Error(`Draft ${draftId} already sending or sent`);
  }

  const draft = claimed.rows[0];

  // Verify board has approved
  if (!draft.board_action || !['approved', 'edited', 'auto_approved'].includes(draft.board_action)) {
    // Release the claim — draft was not approved
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'staged', updated_at = now() WHERE id = $1`,
      [draftId]
    );
    throw new Error(`Draft ${draftId} has not been board-approved (board_action: ${draft.board_action})`);
  }

  // Pre-send region (create-draft + send): release-on-failure is safe here —
  // nothing has gone out yet, so revert to 'staged' for retry. Once send()
  // succeeds the email is irreversibly out and the claim must NEVER be released
  // past this point (a retry would re-claim and re-send — #536 Linus V-5).
  let sendResult;
  try {
    let gmailDraftId = draft.provider_draft_id;
    if (!gmailDraftId) {
      gmailDraftId = await createGmailDraft(draftId);
    }
    const auth = draft.account_id ? await getAuthForAccount(draft.account_id) : getAuth();
    const gmailClient = google.gmail({ version: 'v1', auth });
    sendResult = await gmailClient.users.drafts.send({
      userId: 'me',
      requestBody: { id: gmailDraftId },
    });
  } catch (err) {
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'staged', updated_at = now() WHERE id = $1`,
      [draftId]
    );
    throw err;
  }

  // Send SUCCEEDED. Persist delivered state + audit. If any of this throws, do
  // NOT release: the row stays send_state='sending' (provider_sent_id NULL),
  // which the claim guard blocks from re-claiming → no duplicate send. Log
  // loudly — the email is out; the record/audit may be incomplete.
  try {
    await query(
      `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
       WHERE id = $2`,
      [sendResult.data.id, draftId]
    );
    await publishEvent('draft_sent', `Email sent: ${sendResult.data.id} for draft ${draftId}`, null, null, { draft_id: draftId, provider_sent_id: sendResult.data.id });
    await logCommsIntent({ channel: 'email', recipient: draft.to_addresses?.[0] || 'unknown', subject: draft.subject, body: draft.board_edited_body || draft.body, intentType: 'send', sourceTask: draftId });
  } catch (persistErr) {
    console.error(
      `[sender] CRITICAL: board-approved draft ${draftId} was SENT (gmail id ${sendResult.data.id}) but delivered-state persist/audit failed. Row left locked in 'sending' to prevent re-send; reconcile manually.`,
      persistErr
    );
    throw persistErr;
  }

  console.log(`[sender] Board-approved email sent: ${sendResult.data.id} for draft ${draftId}`);
  return sendResult.data.id;
}
