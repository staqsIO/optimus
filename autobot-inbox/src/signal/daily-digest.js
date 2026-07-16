import { query } from '../db.js';
import { createDraft } from '../gmail/client.js';
import { sendMessage } from '../slack/client.js';

/**
 * Daily email digest: push briefing to Eric's inbox (spec §8, §14 P6).
 * P6: Familiar interfaces for humans — email is the most familiar.
 */

/**
 * Compile and send (or draft) a daily digest email.
 * Multi-account: generates one org-wide digest + per-account summaries.
 * Returns array of Gmail draft IDs.
 */
export async function sendDailyDigest() {
  // Get ALL active email accounts (multi-account support)
  const accountResult = await query(
    `SELECT id, identifier, label FROM inbox.accounts WHERE channel = 'email' AND is_active = true`
  );
  if (accountResult.rows.length === 0) {
    console.warn('[digest] No active email accounts, skipping digest');
    return null;
  }

  // Org-wide data (shared across all accounts)
  const briefingResult = await query(
    `SELECT * FROM signal.briefings WHERE briefing_date = CURRENT_DATE AND account_id IS NULL LIMIT 1`
  );
  const briefing = briefingResult.rows[0];

  const statsResult = await query(`SELECT * FROM signal.v_daily_briefing`);
  const stats = statsResult.rows[0] || {};

  const pendingResult = await query(
    `SELECT d.id, d.subject, d.to_addresses, d.reviewer_verdict, d.account_id,
            m.from_name, m.from_address
     FROM agent_graph.action_proposals d
     LEFT JOIN inbox.messages m ON m.id = d.message_id
     WHERE d.action_type = 'email_draft'
       AND d.send_state = 'reviewed' AND d.board_action IS NULL
     ORDER BY d.created_at DESC
     LIMIT 20`
  );

  const deadlineResult = await query(
    `SELECT s.content, s.due_date, m.from_name, m.subject, m.account_id
     FROM inbox.signals s
     JOIN inbox.messages m ON m.id = s.message_id
     WHERE s.signal_type = 'deadline' AND s.due_date >= CURRENT_DATE
     ORDER BY s.due_date
     LIMIT 10`
  );

  let crossChannelSignals = {};
  let unresolvedActionItems = [];
  try {
    const ccResult = await query(`SELECT * FROM signal.v_cross_channel_signals`);
    crossChannelSignals = ccResult.rows[0] || {};
    const uaResult = await query(
      `SELECT content, source_channel, source_name, created_at
       FROM signal.v_unresolved_action_items
       LIMIT 10`
    );
    unresolvedActionItems = uaResult.rows;
  } catch {
    // Views may not exist yet (pre-migration 007)
  }

  // Budget status — global + per-account
  const budgetResult = await query(
    `SELECT account_id, allocated_usd, spent_usd, reserved_usd
     FROM agent_graph.budgets
     WHERE scope = 'daily' AND period_start = CURRENT_DATE`
  );
  const globalBudget = budgetResult.rows.find(b => !b.account_id);
  const accountBudgets = budgetResult.rows.filter(b => b.account_id);

  // Per-account email counts — one grouped query, not one per account (avoids N+1)
  const emailStatsResult = await query(
    `SELECT account_id, COUNT(*) FILTER (WHERE received_at >= CURRENT_DATE) AS emails_today
     FROM inbox.messages
     GROUP BY account_id`
  );
  const emailsTodayByAccount = new Map(
    emailStatsResult.rows.map(r => [r.account_id, parseInt(r.emails_today || '0')])
  );

  // Build per-account summary sections
  const accountSummaries = [];
  for (const acct of accountResult.rows) {
    const acctPending = pendingResult.rows.filter(d => d.account_id === acct.id);
    const acctDeadlines = deadlineResult.rows.filter(d => d.account_id === acct.id);
    const acctBudget = accountBudgets.find(b => b.account_id === acct.id);

    accountSummaries.push({
      label: acct.label || acct.identifier,
      emailsToday: emailsTodayByAccount.get(acct.id) || 0,
      pendingDrafts: acctPending.length,
      deadlines: acctDeadlines.length,
      budget: acctBudget,
    });
  }

  const body = compileDigest({
    briefing,
    stats,
    pendingDrafts: pendingResult.rows,
    deadlines: deadlineResult.rows,
    budget: globalBudget,
    crossChannelSignals,
    unresolvedActionItems,
    accountSummaries,
    accountCount: accountResult.rows.length,
  });

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
  const subject = `[AutoBot] Daily Digest — ${dateStr}`;

  // Send digest to the first account (board/primary inbox)
  const primaryEmail = accountResult.rows[0].identifier;
  const gmailDraftId = await createDraft(primaryEmail, subject, body);
  console.log(`[digest] Org-wide daily digest draft created: ${gmailDraftId}`);

  // Push condensed digest to Slack board channel (spec §14: push via email + Slack)
  const slackChannel = process.env.SLACK_DIGEST_CHANNEL;
  if (slackChannel) {
    try {
      const actionItems = safeParseJson(briefing?.action_items, []);
      const pendingDrafts = pendingResult.rows;
      const deadlines = deadlineResult.rows;
      const acctLine = accountResult.rows.length > 1
        ? `\n*Accounts:* ${accountResult.rows.length} businesses managed`
        : '';
      const slackBody = [
        `*AutoBot Daily Digest* — ${dateStr}`,
        briefing?.summary ? `\n${briefing.summary}` : '',
        acctLine,
        `\n*Today:* ${stats.emails_received_today ?? 0} received, ${stats.emails_triaged_today ?? 0} triaged, ${stats.drafts_created_today ?? 0} drafts`,
        pendingDrafts.length > 0 ? `*Pending review:* ${pendingDrafts.length} draft(s)` : '',
        actionItems.length > 0 ? `*Action items:* ${actionItems.length}` : '',
        deadlines.length > 0 ? `*Upcoming deadlines:* ${deadlines.length}` : '',
        (crossChannelSignals?.signal_only_today > 0) ? `*Cross-channel signals:* ${crossChannelSignals.signal_only_today} (Linear: ${crossChannelSignals.linear_signals_today || 0}, GitHub: ${crossChannelSignals.github_signals_today || 0})` : '',
        (unresolvedActionItems?.length > 0) ? `*Unresolved action items:* ${unresolvedActionItems.length}` : '',
      ].filter(Boolean).join('\n');

      await sendMessage(slackChannel, slackBody);
      console.log(`[digest] Slack digest posted to ${slackChannel}`);
    } catch (err) {
      console.warn(`[digest] Slack digest failed (non-fatal): ${err.message}`);
    }
  }

  return gmailDraftId;
}

function compileDigest({ briefing, stats, pendingDrafts, deadlines, budget, crossChannelSignals, unresolvedActionItems, accountSummaries = [], accountCount = 1 }) {
  const lines = [];

  lines.push('AUTOBOT DAILY DIGEST');
  lines.push('='.repeat(40));
  lines.push('');

  // Executive summary
  if (briefing?.summary) {
    lines.push('SUMMARY');
    lines.push('-'.repeat(20));
    lines.push(briefing.summary);
    lines.push('');
  }

  // Action items
  const actionItems = safeParseJson(briefing?.action_items, []);
  if (actionItems.length > 0) {
    lines.push('ACTION NEEDED');
    lines.push('-'.repeat(20));
    actionItems.forEach(item => lines.push(`  * ${item}`));
    lines.push('');
  }

  // Pending drafts
  if (pendingDrafts.length > 0) {
    lines.push(`DRAFTS AWAITING REVIEW (${pendingDrafts.length})`);
    lines.push('-'.repeat(20));
    pendingDrafts.forEach(d => {
      const to = d.from_name || d.from_address || d.to_addresses?.[0] || 'unknown';
      lines.push(`  * To: ${to} — ${d.subject || '(no subject)'} [${d.reviewer_verdict || 'pending'}]`);
    });
    lines.push('');
  }

  // Upcoming deadlines
  if (deadlines.length > 0) {
    lines.push('UPCOMING DEADLINES');
    lines.push('-'.repeat(20));
    deadlines.forEach(d => {
      const date = d.due_date ? new Date(d.due_date).toLocaleDateString() : 'TBD';
      lines.push(`  * ${date}: ${d.content} (from ${d.from_name || 'unknown'} re: ${d.subject})`);
    });
    lines.push('');
  }

  // Today's numbers
  lines.push('TODAY\'S NUMBERS');
  lines.push('-'.repeat(20));
  lines.push(`  Emails received:  ${stats.emails_received_today ?? 0}`);
  lines.push(`  Triaged:          ${stats.emails_triaged_today ?? 0}`);
  lines.push(`  Drafts created:   ${stats.drafts_created_today ?? 0}`);
  lines.push(`  Drafts approved:  ${stats.drafts_approved_today ?? 0}`);
  lines.push(`  Drafts edited:    ${stats.drafts_edited_today ?? 0}`);
  if (budget) {
    const spent = parseFloat(budget.spent_usd || 0).toFixed(2);
    const allocated = parseFloat(budget.allocated_usd || 20).toFixed(2);
    lines.push(`  Budget:           $${spent} / $${allocated}`);
  }
  lines.push('');

  // Cross-channel activity
  const hasChannelActivity = (crossChannelSignals?.linear_signals_today > 0)
    || (crossChannelSignals?.github_signals_today > 0)
    || (crossChannelSignals?.transcript_signals_today > 0);

  if (hasChannelActivity) {
    lines.push('CROSS-CHANNEL ACTIVITY');
    lines.push('-'.repeat(20));
    if (crossChannelSignals.linear_signals_today > 0) {
      lines.push(`  Linear:       ${crossChannelSignals.linear_signals_today} signal(s)`);
    }
    if (crossChannelSignals.github_signals_today > 0) {
      lines.push(`  GitHub:       ${crossChannelSignals.github_signals_today} signal(s)`);
    }
    if (crossChannelSignals.transcript_signals_today > 0) {
      lines.push(`  Transcripts:  ${crossChannelSignals.transcript_signals_today} signal(s)`);
    }
    lines.push('');
  }

  // Unresolved action items (cross-channel)
  if (unresolvedActionItems?.length > 0) {
    lines.push(`UNRESOLVED ACTION ITEMS (${unresolvedActionItems.length})`);
    lines.push('-'.repeat(20));
    unresolvedActionItems.forEach(item => {
      const src = item.source_channel ? `[${item.source_channel}]` : '';
      const who = item.source_name ? ` from ${item.source_name}` : '';
      lines.push(`  * ${src} ${item.content}${who}`);
    });
    lines.push('');
  }

  // Signals
  const signals = safeParseJson(briefing?.signals, []);
  if (signals.length > 0) {
    lines.push('SIGNALS');
    lines.push('-'.repeat(20));
    signals.forEach(s => lines.push(`  * ${s}`));
    lines.push('');
  }

  // Per-account breakdown (multi-account)
  if (accountSummaries.length > 1) {
    lines.push(`ACCOUNT BREAKDOWN (${accountCount} businesses)`);
    lines.push('-'.repeat(20));
    for (const acct of accountSummaries) {
      const budgetStr = acct.budget
        ? ` | Budget: $${parseFloat(acct.budget.spent_usd || 0).toFixed(2)}/$${parseFloat(acct.budget.allocated_usd || 5).toFixed(2)}`
        : '';
      lines.push(`  ${acct.label}: ${acct.emailsToday} emails, ${acct.pendingDrafts} pending drafts, ${acct.deadlines} deadlines${budgetStr}`);
    }
    lines.push('');
  }

  // Autonomy status
  lines.push('AUTONOMY STATUS');
  lines.push('-'.repeat(20));
  lines.push(`  Level: L${process.env.AUTONOMY_LEVEL || '0'}`);
  lines.push(`  14-day edit rate: ${stats.edit_rate_14d_pct ?? 'N/A'}%`);
  lines.push(`  Drafts reviewed (14d): ${stats.drafts_reviewed_14d ?? 0} / 50`);
  lines.push('');

  lines.push('-'.repeat(40));
  lines.push('Generated by AutoBot Architect agent');
  lines.push('Review drafts: run `npm run cli` → review');

  return lines.join('\n');
}

function safeParseJson(val, fallback) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return fallback;
}
