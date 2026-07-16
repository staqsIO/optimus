/**
 * Governance notification helpers.
 * Sends Slack messages for key governance lifecycle events.
 * All notifications are best-effort (non-blocking, fail-silent).
 */

const CHANNEL = process.env.SLACK_GOVERNANCE_CHANNEL || process.env.SLACK_NOTIFICATIONS_CHANNEL;

// Board member Slack user IDs for @mention DMs
// Set via env vars: SLACK_USER_DUSTIN, SLACK_USER_ERIC
const BOARD_MEMBERS = {
  dustin: process.env.SLACK_USER_DUSTIN || null,
  eric: process.env.SLACK_USER_ERIC || null,
};

/**
 * Notify on new governance submission.
 */
export async function notifySubmission(submission) {
  if (!CHANNEL) return;
  try {
    const { sendMessage } = await import('../slack/client.js');
    const typeLabel = submission.content_type.replace(/_/g, ' ');
    const agentTag = submission.submitted_by === 'board' ? '' : ` (from agent: ${submission.submitted_by})`;
    await sendMessage(
      CHANNEL,
      `*New governance submission:* ${submission.title}\n` +
      `Type: ${typeLabel}${agentTag}\n` +
      `_Queued for intake classification._`
    );
  } catch (err) {
    console.warn(`[governance-notify] submission notification failed: ${err.message}`);
  }
}

/**
 * Notify when audit completes with results summary.
 */
export async function notifyAuditComplete(submission, auditResult) {
  if (!CHANNEL) return;
  try {
    const { sendMessage } = await import('../slack/client.js');
    const score = auditResult.overall_score ?? '?';
    const rec = auditResult.recommendation ?? 'unknown';
    const flags = (auditResult.flags || []).length;
    const cost = auditResult.cost_usd ? `$${Number(auditResult.cost_usd).toFixed(4)}` : '';

    let scoreEmoji = ':white_check_mark:';
    if (typeof score === 'number') {
      if (score < 4) scoreEmoji = ':red_circle:';
      else if (score < 7) scoreEmoji = ':large_yellow_circle:';
    }

    await sendMessage(
      CHANNEL,
      `${scoreEmoji} *Audit complete:* ${submission.title}\n` +
      `Score: *${score}/10* | Recommendation: *${rec}*` +
      (flags > 0 ? ` | ${flags} flag${flags !== 1 ? 's' : ''}` : '') +
      (cost ? ` | Cost: ${cost}` : '') +
      `\n_Awaiting board review._`
    );
  } catch (err) {
    console.warn(`[governance-notify] audit notification failed: ${err.message}`);
  }
}

/**
 * Notify when a board decision is made.
 */
export async function notifyDecision(submission, decision, reason = null, workItemId = null) {
  if (!CHANNEL) return;
  try {
    const { sendMessage } = await import('../slack/client.js');
    const emoji = {
      accepted: ':white_check_mark:',
      rejected: ':x:',
      deferred: ':hourglass:',
      superseded: ':arrows_counterclockwise:',
    }[decision] || ':grey_question:';

    let text = `${emoji} *${decision.charAt(0).toUpperCase() + decision.slice(1)}:* ${submission.title}`;
    if (reason) text += `\nReason: ${reason}`;
    if (workItemId) text += `\nWork item created: \`${workItemId}\``;

    await sendMessage(CHANNEL, text);
  } catch (err) {
    console.warn(`[governance-notify] decision notification failed: ${err.message}`);
  }
}

/**
 * Notify mentioned board members via Slack DM when @mentioned in discussion.
 * Extracts @dustin, @eric etc. from message text and sends a DM to each.
 */
export async function notifyMentions(submissionTitle, message, author) {
  const mentions = message.match(/@(\w+)/g);
  if (!mentions || mentions.length === 0) return;

  try {
    const { sendMessage } = await import('../slack/client.js');

    for (const mention of mentions) {
      const name = mention.slice(1).toLowerCase(); // remove @
      const slackUserId = BOARD_MEMBERS[name];
      if (!slackUserId) continue;

      await sendMessage(
        slackUserId,
        `*You were mentioned in a governance discussion:*\n` +
        `*Submission:* ${submissionTitle}\n` +
        `*${author}:* ${message}\n` +
        `_View at board.staqs.io/governance_`
      );
      console.log(`[governance-notify] DM sent to ${name} (${slackUserId}) for mention`);
    }
  } catch (err) {
    console.warn(`[governance-notify] mention notification failed: ${err.message}`);
  }
}

/**
 * Notify channel when a discussion comment is added.
 */
export async function notifyDiscussion(submissionTitle, message, author) {
  if (!CHANNEL) return;
  try {
    const { sendMessage } = await import('../slack/client.js');
    await sendMessage(
      CHANNEL,
      `*Discussion on:* ${submissionTitle}\n*${author}:* ${message}`
    );
  } catch (err) {
    console.warn(`[governance-notify] discussion notification failed: ${err.message}`);
  }

  // Also DM any @mentioned board members
  notifyMentions(submissionTitle, message, author).catch(() => {});
}
