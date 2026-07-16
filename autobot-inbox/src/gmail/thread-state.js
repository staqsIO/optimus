/**
 * Pure classifier for Gmail thread state, used by the auto-archive
 * sweep to decide whether a stale action_proposal should be hidden
 * from the board.
 *
 * Pure: takes a Gmail thread payload (the result of
 * gmail.users.threads.get) plus the set of "user" addresses (e.g.
 * eric@staqs.io, eric.personal@example.com) plus the proposal's created_at,
 * and returns one of:
 *
 *   'eric_replied'        — User replied to the original message
 *                            after the proposal was created. The
 *                            proposal is stale; the board should hide
 *                            it as `archived_external`.
 *   'archived_no_reply'   — User did not reply but archived the thread
 *                            in Gmail (no INBOX label on the latest
 *                            message). Board hides as `archived_no_reply`.
 *   'still_open'          — Neither replied nor archived. Leave the
 *                            proposal visible on the board.
 *
 * No DB access, no API calls — easy to unit test.
 */

/**
 * Extract the lowercased From-address from a Gmail message payload.
 * Returns '' when missing.
 */
function fromAddress(message) {
  const headers = message?.payload?.headers || [];
  const fromHeader = headers.find((h) => h?.name?.toLowerCase() === 'from');
  if (!fromHeader?.value) return '';
  // From values look like "Name <email@host>" — extract the angle-bracket part.
  const match = fromHeader.value.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader.value).trim().toLowerCase();
}

function isUserAddress(address, userAddresses) {
  if (!address) return false;
  for (const ua of userAddresses) {
    if (ua && address === String(ua).toLowerCase()) return true;
  }
  return false;
}

/**
 * Classify a Gmail thread relative to a proposal's created_at timestamp.
 *
 * @param {{ messages?: Array<object> }} thread - result of gmail.users.threads.get
 * @param {Iterable<string>} userAddresses - the user's email addresses
 * @param {Date|string|number} proposalCreatedAt - when the AI draft was created
 * @returns {'eric_replied'|'archived_no_reply'|'still_open'}
 */
export function classifyThreadState(thread, userAddresses, proposalCreatedAt) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (messages.length === 0) return 'still_open';

  const userAddrLower = new Set(
    [...userAddresses].filter(Boolean).map((a) => String(a).toLowerCase())
  );

  const proposalMs = new Date(proposalCreatedAt).getTime();
  if (!Number.isFinite(proposalMs)) return 'still_open';

  // Sort by internalDate ascending — Gmail returns ms-epoch as string.
  const sorted = [...messages].sort((a, b) => {
    const da = Number(a?.internalDate || 0);
    const db = Number(b?.internalDate || 0);
    return da - db;
  });

  // Did the user reply after the proposal was created?
  // Anchor: the first user message whose internalDate > proposalMs.
  // (We don't bother with the "before any non-user message" refinement
  // here — for queue cleanup, any user reply on the thread post-proposal
  // is a strong-enough signal that the proposal is stale.)
  for (const msg of sorted) {
    const ts = Number(msg?.internalDate || 0);
    if (ts <= proposalMs) continue;
    if (isUserAddress(fromAddress(msg), userAddrLower)) {
      return 'eric_replied';
    }
  }

  // No user reply. Did the thread get archived?
  // Gmail's "archive" removes the INBOX label from the latest message
  // on the thread. If the latest message has no INBOX label, the thread
  // is archived. (Other label-driven moves like Spam / Trash also remove
  // INBOX, which we treat the same — the user has handled it.)
  const latest = sorted[sorted.length - 1];
  const latestLabels = Array.isArray(latest?.labelIds) ? latest.labelIds : [];
  const stillInInbox = latestLabels.includes('INBOX');
  if (!stillInInbox) return 'archived_no_reply';

  return 'still_open';
}

/**
 * Map a classification to the corresponding `board_action` value.
 */
export function classificationToBoardAction(classification) {
  if (classification === 'eric_replied') return 'archived_external';
  if (classification === 'archived_no_reply') return 'archived_no_reply';
  return null;
}
