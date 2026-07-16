import chalk from 'chalk';
import { query } from '../../db.js';

/**
 * Decide command: review and render verdicts on pending strategic decisions.
 * Populates suggest_mode_log for G4 (Strategic Decision Quality) measurement.
 *
 * Also supports marking past decisions as reversed:
 *   decide reverse <id> [reason]
 */
export async function decideCommand(args, rl) {
  // Sub-command: reverse a past decision (Gap 2)
  if (args[0] === 'reverse') {
    return reverseDecision(args.slice(1), rl);
  }

  // List pending strategic decisions
  const result = await query(
    `SELECT sd.id, sd.decision_type, sd.proposed_action, sd.rationale,
            sd.recommendation, sd.confidence, sd.created_at,
            w.title AS work_item_title
     FROM agent_graph.strategic_decisions sd
     LEFT JOIN agent_graph.work_items w ON w.id = sd.work_item_id
     WHERE sd.board_verdict IS NULL
     ORDER BY sd.created_at ASC`
  );

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No strategic decisions pending review.'));
    return;
  }

  console.log(chalk.bold(`\n  ${result.rows.length} strategic decision(s) pending review\n`));

  for (const decision of result.rows) {
    console.log(chalk.gray('  ' + '─'.repeat(80)));
    console.log(chalk.bold(`  Decision: ${decision.id.slice(0, 8)}...`));
    console.log(`  Type: ${chalk.yellow(decision.decision_type)} | Confidence: ${decision.confidence}/5`);
    console.log(`  Work Item: ${decision.work_item_title || '(none)'}`);
    console.log(`  Agent Recommends: ${chalk.cyan(decision.recommendation)}`);
    console.log(`  Proposed Action: ${decision.proposed_action}`);
    if (decision.rationale) {
      console.log(`  Rationale: ${chalk.gray(decision.rationale)}`);
    }
    console.log();

    const action = await askLine(rl, chalk.cyan('  [a]pprove / [r]eject / [m]odify / [S]kip: '));

    const verdictMap = { a: 'approved', approve: 'approved', r: 'rejected', reject: 'rejected', m: 'modified', modify: 'modified' };
    const verdict = verdictMap[action];

    if (!verdict) {
      console.log(chalk.gray('  Skipped.'));
      continue;
    }

    let notes = null;
    if (verdict === 'rejected' || verdict === 'modified') {
      notes = await askLine(rl, chalk.cyan('  Notes (reason): '));
    }

    // Update the decision
    await query(
      `UPDATE agent_graph.strategic_decisions
       SET board_verdict = $1, board_notes = $2, decided_by = 'board', decided_at = now()
       WHERE id = $3`,
      [verdict, notes || null, decision.id]
    );

    // Log to suggest_mode_log for G4 measurement
    const verdictMatchMap = {
      approved: ['proceed'],
      rejected: ['reject', 'defer'],
      modified: [],
    };
    const matched = (verdictMatchMap[verdict] || []).includes(decision.recommendation);
    const mismatchReason = matched ? null
      : `Agent recommended "${decision.recommendation}", board decided "${verdict}"${notes ? `: ${notes}` : ''}`;

    await query(
      `INSERT INTO agent_graph.suggest_mode_log
       (decision_id, agent_recommendation, board_decision, matched, mismatch_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [decision.id, decision.recommendation, verdict, matched, mismatchReason]
    );

    const matchLabel = matched ? chalk.green('MATCH') : chalk.yellow('MISMATCH');
    console.log(chalk.green(`  ${verdict.charAt(0).toUpperCase() + verdict.slice(1)}. [${matchLabel}]`));
  }
}

/**
 * Mark a past strategic decision as reversed (Gap 2).
 * Usage: decide reverse <decision-id-prefix> [reason]
 */
async function reverseDecision(args, rl) {
  const idPrefix = args[0];
  if (!idPrefix) {
    console.log(chalk.yellow('  Usage: decide reverse <decision-id-prefix> [reason]'));
    return;
  }

  // Find the decision by prefix
  const result = await query(
    `SELECT id, proposed_action, recommendation, board_verdict, outcome
     FROM agent_graph.strategic_decisions
     WHERE id LIKE $1
     ORDER BY created_at DESC LIMIT 5`,
    [idPrefix + '%']
  );

  if (result.rows.length === 0) {
    console.log(chalk.red(`  No decision found matching "${idPrefix}"`));
    return;
  }

  if (result.rows.length > 1) {
    console.log(chalk.yellow(`  Multiple matches for "${idPrefix}":`));
    for (const r of result.rows) {
      console.log(chalk.gray(`    ${r.id} — ${r.proposed_action} [${r.board_verdict || 'pending'}]`));
    }
    console.log(chalk.yellow('  Please provide a longer prefix.'));
    return;
  }

  const decision = result.rows[0];

  if (decision.outcome === 'reversed') {
    console.log(chalk.yellow(`  Decision ${decision.id.slice(0, 8)}... already marked as reversed.`));
    return;
  }

  const reason = args.slice(1).join(' ') || await askLine(rl, chalk.cyan('  Reversal reason: '));

  await query(
    `UPDATE agent_graph.strategic_decisions
     SET outcome = 'reversed', board_notes = COALESCE(board_notes || E'\\n', '') || $1
     WHERE id = $2`,
    [`Reversed: ${reason}`, decision.id]
  );

  console.log(chalk.green(`  Decision ${decision.id.slice(0, 8)}... marked as reversed.`));
}

function askLine(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}
