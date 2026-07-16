import chalk from 'chalk';
import { query } from '../../db.js';

/**
 * Inbox command: show triaged emails and pending items.
 */
export async function inboxCommand(args) {
  const filter = args[0]; // 'pending', 'action', 'response', 'fyi', 'noise', or 'all'

  let sql = `
    SELECT m.id, m.from_address, m.from_name, m.subject, m.received_at,
           m.triage_category, m.priority_score, m.processed_at,
           (SELECT COUNT(*) FROM inbox.signals s WHERE s.message_id = m.id) AS signal_count,
           (SELECT COUNT(*) FROM agent_graph.action_proposals d WHERE d.message_id = m.id AND d.action_type = 'email_draft' AND d.board_action IS NULL AND d.reviewer_verdict IS NOT NULL) AS pending_drafts
    FROM inbox.messages m
  `;
  const params = [];

  if (filter === 'pending') {
    sql += ` WHERE m.triage_category = 'pending'`;
  } else if (filter === 'action') {
    sql += ` WHERE m.triage_category = 'action_required'`;
  } else if (filter === 'response') {
    sql += ` WHERE m.triage_category = 'needs_response'`;
  } else if (filter === 'fyi') {
    sql += ` WHERE m.triage_category = 'fyi'`;
  } else if (filter === 'noise') {
    sql += ` WHERE m.triage_category = 'noise'`;
  } else {
    sql += ` WHERE m.archived_at IS NULL`;
  }

  sql += ` ORDER BY m.received_at DESC LIMIT 25`;

  const result = await query(sql, params);

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No emails found.'));
    return;
  }

  console.log(chalk.bold(`\n  Inbox (${result.rows.length} emails)`));
  console.log(chalk.gray('  ' + '─'.repeat(90)));

  for (const email of result.rows) {
    const cat = formatCategory(email.triage_category);
    const from = (email.from_name || email.from_address).slice(0, 25).padEnd(25);
    const subject = (email.subject || '(no subject)').slice(0, 40).padEnd(40);
    const time = new Date(email.received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const signals = email.signal_count > 0 ? chalk.yellow(` [${email.signal_count} signals]`) : '';
    const drafts = email.pending_drafts > 0 ? chalk.green(` [draft ready]`) : '';
    const priority = email.priority_score != null ? chalk.gray(` P${email.priority_score}`) : '';

    console.log(`  ${cat} ${from} ${subject} ${time}${priority}${signals}${drafts}`);
  }

  console.log();
}

function formatCategory(cat) {
  switch (cat) {
    case 'action_required': return chalk.red('ACTION');
    case 'needs_response':  return chalk.yellow('REPLY ');
    case 'fyi':             return chalk.blue('FYI   ');
    case 'noise':           return chalk.gray('NOISE ');
    case 'pending':         return chalk.white('PEND  ');
    default:                return chalk.gray('???   ');
  }
}
