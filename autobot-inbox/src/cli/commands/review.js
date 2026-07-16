import chalk from 'chalk';

import { query } from '../../db.js';
import { recordEditDelta } from '../../voice/edit-tracker.js';
import { createGmailDraft, sendApprovedDraft } from '../../gmail/sender.js';

/**
 * Review command: approve/edit/reject pending drafts.
 * G4: In L0, every draft requires board approval.
 */
export async function reviewCommand(args, rl) {
  // Get pending drafts (reviewed by agent, awaiting board action)
  const result = await query(
    `SELECT d.*, m.from_address, m.from_name, m.subject AS email_subject,
            m.snippet, m.triage_category
     FROM agent_graph.action_proposals d
     JOIN inbox.messages m ON d.message_id = m.id
     WHERE d.action_type = 'email_draft'
       AND d.reviewer_verdict IS NOT NULL
       AND d.board_action IS NULL
     ORDER BY d.created_at ASC`
  );

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No drafts pending review.'));
    return;
  }

  console.log(chalk.bold(`\n  ${result.rows.length} draft(s) pending review\n`));

  for (const draft of result.rows) {
    console.log(chalk.gray('  ' + '─'.repeat(80)));
    console.log(chalk.bold(`  To: ${draft.from_address}`));
    console.log(chalk.bold(`  Re: ${draft.email_subject || '(no subject)'}`));
    console.log(chalk.gray(`  Reviewer: ${draft.reviewer_verdict} | Tone: ${draft.tone_score ?? 'N/A'}`));

    // Show gate flags
    const gates = draft.gate_results ? JSON.parse(JSON.stringify(draft.gate_results)) : {};
    const failedGates = Object.entries(gates).filter(([, v]) => !v.passed);
    if (failedGates.length > 0) {
      console.log(chalk.red(`  FLAGS: ${failedGates.map(([k]) => k).join(', ')}`));
    }

    console.log();
    console.log(chalk.white(indent(draft.body, 4)));
    console.log();

    // Prompt for action
    const action = await askLine(rl, chalk.cyan('  [a]pprove (draft) / [s]end (approve+send) / [e]dit / [r]eject / [S]kip: '));

    if (action === 'a' || action === 'approve') {
      await query(
        `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), send_state = 'approved'
         WHERE id = $1`,
        [draft.id]
      );

      // Create Gmail draft (safe default — review in Gmail before sending)
      try {
        await createGmailDraft(draft.id);
        console.log(chalk.green('  Approved. Gmail draft created. Use "send" command to send later.'));
      } catch (err) {
        console.log(chalk.green('  Approved.'));
        console.log(chalk.yellow(`  Gmail draft failed: ${err.message}`));
      }
    } else if (action === 's' || action === 'send') {
      // Approve AND send in one step — board approval IS the L0 human check
      await query(
        `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), send_state = 'approved'
         WHERE id = $1`,
        [draft.id]
      );

      try {
        await sendApprovedDraft(draft.id);
        console.log(chalk.green('  Approved and sent.'));
      } catch (err) {
        console.log(chalk.green('  Approved.'));
        console.log(chalk.red(`  Send failed: ${err.message}`));
        console.log(chalk.yellow('  Use "send" command to retry.'));
      }
    } else if (action === 'e' || action === 'edit') {
      console.log(chalk.gray('  Enter edited body (end with a line containing just "."):\n'));

      const editedBody = await readMultiline(rl);

      if (editedBody.trim()) {
        // Record edit delta (D4: most valuable data)
        await recordEditDelta({
          draftId: draft.id,
          emailId: draft.message_id,
          originalBody: draft.body,
          editedBody,
          recipient: draft.from_address || draft.to_addresses?.[0],
          subject: draft.email_subject,
          triageCategory: draft.triage_category,
        });

        await query(
          `UPDATE agent_graph.action_proposals
           SET board_action = 'edited', board_edited_body = $1, acted_at = now(), send_state = 'approved'
           WHERE id = $2`,
          [editedBody, draft.id]
        );

        // Edit implies intent to send
        try {
          await sendApprovedDraft(draft.id);
          console.log(chalk.green('  Edited and sent.'));
        } catch (err) {
          console.log(chalk.green('  Edited and saved.'));
          console.log(chalk.yellow(`  Send failed: ${err.message}. Use "send" command to retry.`));
        }
      } else {
        console.log(chalk.yellow('  Empty edit — skipped.'));
      }
    } else if (action === 'r' || action === 'reject') {
      const reason = await askLine(rl, chalk.cyan('  Rejection reason: '));
      await query(
        `UPDATE agent_graph.action_proposals SET board_action = 'rejected', board_notes = $1, acted_at = now(), send_state = 'cancelled'
         WHERE id = $2`,
        [reason, draft.id]
      );
      console.log(chalk.red('  Rejected.'));
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

function readMultiline(rl) {
  return new Promise((resolve) => {
    const lines = [];
    const handler = (line) => {
      if (line.trim() === '.') {
        rl.removeListener('line', handler);
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    };
    rl.on('line', handler);
  });
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(l => pad + l).join('\n');
}
