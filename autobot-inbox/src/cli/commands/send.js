import chalk from 'chalk';
import { query } from '../../db.js';
import { sendApprovedDraft } from '../../gmail/sender.js';

/**
 * Send command: send previously approved-but-unsent drafts.
 * Board approval IS the L0 human check — sending after approval is safe.
 */
export async function sendCommand(args, rl) {
  // Find approved drafts that haven't been sent
  const result = await query(
    `SELECT d.*, m.from_address, m.from_name, m.subject AS email_subject
     FROM agent_graph.action_proposals d
     JOIN inbox.messages m ON d.message_id = m.id
     WHERE d.action_type = 'email_draft'
       AND d.board_action IN ('approved', 'edited', 'auto_approved')
       AND d.send_state IN ('approved', 'staged')
       AND d.provider_sent_id IS NULL
     ORDER BY d.acted_at ASC`
  );

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No approved drafts waiting to be sent.'));
    return;
  }

  console.log(chalk.bold(`\n  ${result.rows.length} approved draft(s) ready to send\n`));

  for (const draft of result.rows) {
    console.log(chalk.gray('  ' + '─'.repeat(60)));
    console.log(chalk.bold(`  To: ${draft.from_address}`));
    console.log(chalk.bold(`  Re: ${draft.email_subject || '(no subject)'}`));
    console.log(chalk.gray(`  Action: ${draft.board_action} | Draft: ${draft.provider_draft_id ? 'yes' : 'no'}`));
    console.log();

    const body = draft.board_edited_body || draft.body;
    console.log(chalk.white(indent(body, 4)));
    console.log();

    const action = await askLine(rl, chalk.cyan('  [s]end / [S]kip: '));

    if (action === 's' || action === 'send') {
      try {
        const sentId = await sendApprovedDraft(draft.id);
        console.log(chalk.green(`  Sent. (${sentId})`));
      } catch (err) {
        console.log(chalk.red(`  Send failed: ${err.message}`));
      }
    } else {
      console.log(chalk.gray('  Skipped.'));
    }
  }
}

function askLine(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(l => pad + l).join('\n');
}
