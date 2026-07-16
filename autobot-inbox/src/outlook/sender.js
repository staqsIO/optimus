import { query } from '../db.js';
import { createOutlookDraftMessage } from './client.js';
import { logCommsIntent, publishEvent } from '../runtime/infrastructure.js';

/**
 * Outlook sender: creates drafts (L0) or sends emails (L1+).
 * Mirrors gmail/sender.js. D2: In L0, ALWAYS create drafts, never send directly.
 * G5: Reversibility — drafts are reversible, sends are not.
 */

/**
 * Create an Outlook draft for a reviewed+approved draft.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Outlook draft message ID
 */
export async function createOutlookDraft(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  // Get the original email for threading
  const emailResult = await query(`SELECT * FROM inbox.messages WHERE id = $1`, [draft.message_id]);
  const email = emailResult.rows[0];

  const body = draft.board_edited_body || draft.body;
  const to = draft.to_addresses[0];
  const subject = draft.subject || `Re: ${email?.subject || ''}`;

  const outlookDraftId = await createOutlookDraftMessage(
    to,
    subject,
    body,
    email?.thread_id || null,
    email?.message_id || null,
    draft.account_id
  );

  // Update draft record
  await query(
    `UPDATE agent_graph.action_proposals SET provider_draft_id = $1, send_state = 'staged', updated_at = now()
     WHERE id = $2`,
    [outlookDraftId, draftId]
  );

  // Shadow log the communication intent
  await logCommsIntent({ channel: 'email', recipient: to, subject, body, intentType: 'draft', sourceAgent: 'executor-responder', sourceTask: draftId });
  await publishEvent('draft_created', `Outlook draft created for ${draftId}`, null, null, { draft_id: draftId });

  console.log(`[outlook-sender] Draft created: ${outlookDraftId} for draft ${draftId}`);
  return outlookDraftId;
}

/**
 * Send a board-approved draft via Outlook.
 * Board approval IS the L0 human check, so this works at any autonomy level.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Outlook sent message ID
 */
export async function sendApprovedOutlookDraft(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  // Verify board has approved
  if (!draft.board_action || !['approved', 'edited', 'auto_approved'].includes(draft.board_action)) {
    throw new Error(`Draft ${draftId} has not been board-approved (board_action: ${draft.board_action})`);
  }

  // Already sent
  if (draft.provider_sent_id) {
    throw new Error(`Draft ${draftId} has already been sent (${draft.provider_sent_id})`);
  }

  // Create Outlook draft if not already created
  let outlookDraftId = draft.provider_draft_id;
  if (!outlookDraftId) {
    outlookDraftId = await createOutlookDraft(draftId);
  }

  // Send the draft via Graph API
  const { getOutlookAuth } = await import('./auth.js');
  const accessToken = await getOutlookAuth(draft.account_id);

  const sendResponse = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${outlookDraftId}/send`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );

  if (!sendResponse.ok) {
    const errText = await sendResponse.text();
    throw new Error(`Outlook send failed: ${sendResponse.status} ${errText}`);
  }

  // Graph /send returns 202 Accepted, message ID is the draft ID
  const sentId = outlookDraftId;

  // Update draft record
  await query(
    `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
     WHERE id = $2`,
    [sentId, draftId]
  );

  await publishEvent('draft_sent', `Outlook email sent for draft ${draftId}`, null, null, { draft_id: draftId, provider_sent_id: sentId });
  await logCommsIntent({ channel: 'email', recipient: draft.to_addresses?.[0] || 'unknown', subject: draft.subject, body: draft.board_edited_body || draft.body, intentType: 'send', sourceTask: draftId });

  console.log(`[outlook-sender] Email sent: ${sentId} for draft ${draftId}`);
  return sentId;
}
