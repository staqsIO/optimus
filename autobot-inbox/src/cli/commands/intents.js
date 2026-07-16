import chalk from 'chalk';
import { query, withTransaction } from '../../db.js';
import { transitionIntent } from '../../runtime/intent-manager.js';

/**
 * Intents command: review and manage agent-proposed work items.
 * P6: Familiar interface for board. P1: deny by default (all intents need approval at L0).
 *
 * Sub-commands:
 *   intents                  — list pending intents
 *   intents approve <id>     — approve an intent (creates work item)
 *   intents reject <id> [reason] — reject with feedback
 *   intents history          — show recent intent history
 *   intents rates            — show intent match rates per agent
 */
export async function intentsCommand(args, rl) {
  const sub = args[0];

  if (sub === 'approve') return approveIntent(args.slice(1), rl);
  if (sub === 'reject') return rejectIntent(args.slice(1), rl);
  if (sub === 'history') return showHistory();
  if (sub === 'rates') return showMatchRates();

  // Default: list pending intents
  return listPending();
}

async function listPending() {
  const result = await query(
    `SELECT id, agent_id, agent_tier, intent_type, decision_tier,
            title, reasoning, proposed_action, trigger_context,
            trigger_type, created_at, expires_at
     FROM agent_graph.agent_intents
     WHERE status = 'pending'
     ORDER BY
       CASE decision_tier
         WHEN 'existential' THEN 0
         WHEN 'strategic' THEN 1
         WHEN 'tactical' THEN 2
       END,
       created_at ASC`
  );

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No pending intents.'));
    return;
  }

  console.log(chalk.bold(`\n  ${result.rows.length} pending intent(s)\n`));

  for (const intent of result.rows) {
    const tierColor = {
      existential: chalk.red,
      strategic: chalk.yellow,
      tactical: chalk.blue,
    }[intent.decision_tier] || chalk.white;

    const expiresIn = intent.expires_at
      ? formatTimeRemaining(new Date(intent.expires_at))
      : 'no expiry';

    console.log(chalk.gray('  ' + '─'.repeat(80)));
    console.log(chalk.bold(`  ${intent.id.slice(0, 8)}  `) +
      tierColor(`[${intent.decision_tier}]`) +
      chalk.gray(` ${intent.intent_type} from ${intent.agent_id} (${intent.agent_tier})`));
    console.log(`  ${chalk.white(intent.title)}`);
    console.log(chalk.gray(`  Reasoning: ${truncate(intent.reasoning, 120)}`));

    if (intent.trigger_context) {
      const ctx = intent.trigger_context;
      if (ctx.pattern) console.log(chalk.gray(`  Pattern: ${ctx.pattern}`));
      if (ctx.signal_ids) console.log(chalk.gray(`  Signals: ${ctx.signal_ids.length} related`));
      // Governance intents: show structured evidence
      if (ctx.gate_id) {
        console.log(chalk.magenta(`  Gate: ${ctx.gate_id} (${ctx.parameter}): ${ctx.current_value} → ${ctx.proposed_value}`));
        if (ctx.evidence) {
          console.log(chalk.gray(`  Evidence: ${ctx.evidence.total_checked} checked, ${(ctx.evidence.false_positive_rate * 100).toFixed(1)}% false positive rate`));
        }
      }
    }

    const action = intent.proposed_action;
    if (action.type === 'create_work_item') {
      console.log(chalk.cyan(`  Action: create work item → ${action.payload?.assigned_to || 'unassigned'}`));
    } else if (action.type === 'create_schedule') {
      console.log(chalk.cyan(`  Action: create schedule (${action.payload?.schedule_type || 'once'})`));
    } else if (action.type === 'modify_gate') {
      console.log(chalk.magenta(`  Action: modify gate ${action.payload?.gate_id}`));
    } else {
      console.log(chalk.cyan(`  Action: ${action.type}`));
    }

    if (intent.trigger_type !== 'once') {
      console.log(chalk.gray(`  Trigger: ${intent.trigger_type}`));
    }

    console.log(chalk.gray(`  Created: ${formatRelativeTime(intent.created_at)} | Expires: ${expiresIn}`));
  }

  console.log(chalk.gray('\n  ' + '─'.repeat(80)));
  console.log(chalk.gray('  Commands: intents approve <id> | intents reject <id> [reason]'));
  console.log();
}

/**
 * Fix 1: Atomic approve→execute flow.
 * Wraps transitionIntent(approved) + createWorkItem() + transitionIntent(executed)
 * in a single transaction. If createWorkItem fails, approval rolls back.
 *
 * Fix 7: Rejects approval of unimplemented action types instead of logging
 * "executed" for no-ops.
 */
async function approveIntent(args, _rl) {
  const idPrefix = args[0];
  if (!idPrefix) {
    console.log(chalk.yellow('  Usage: intents approve <id-prefix>'));
    return;
  }

  const intent = await findIntent(idPrefix);
  if (!intent) return;

  const action = intent.proposed_action;

  // Fix 7: Validate action type is implementable before approving
  const supportedActions = ['create_work_item'];
  if (!supportedActions.includes(action.type)) {
    console.log(chalk.yellow(`  Action type "${action.type}" is not yet implemented. Cannot approve.`));
    console.log(chalk.gray(`  Reject this intent or wait for implementation.`));
    return;
  }

  // Fix 1: Atomic transaction — approve + execute + create work item.
  // No TOCTOU pre-check: the WHERE status = 'pending' inside the transaction
  // is the single authoritative guard against race conditions.
  try {
    await withTransaction(async (client) => {
      // Step 1: Approve (atomic guard — only succeeds if still pending)
      const approveResult = await client.query(
        `UPDATE agent_graph.agent_intents
         SET status = 'approved', reviewed_by = 'board', reviewed_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [intent.id]
      );

      if (approveResult.rows.length === 0) {
        throw new Error(`Intent ${intent.id.slice(0, 8)}... is no longer pending (may have been approved, rejected, or expired)`);
      }

      // Step 2: Execute the proposed action
      const payload = action.payload || {};
      const item = await client.query(
        `INSERT INTO agent_graph.work_items
         (type, title, description, created_by, assigned_to, priority, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          payload.type || 'task',
          payload.title || intent.title,
          payload.description || intent.reasoning,
          'board',
          payload.assigned_to || null,
          payload.priority || 0,
          JSON.stringify({
            source: 'intent',
            intent_id: intent.id,
            original_agent: intent.agent_id,
            ...payload.metadata,
          }),
        ]
      );
      const workItem = item.rows[0];
      console.log(chalk.green(`  Approved → Work item created: ${workItem.id.slice(0, 8)}...`));
      if (payload.assigned_to) {
        console.log(chalk.gray(`  Assigned to: ${payload.assigned_to}`));
      }

      // Step 3: Mark as executed (within same transaction)
      await client.query(
        `UPDATE agent_graph.agent_intents
         SET status = 'executed', executed_at = now()
         WHERE id = $1 AND status = 'approved'`,
        [intent.id]
      );
    });

    console.log(chalk.gray(`  Intent: ${intent.title}`));
  } catch (err) {
    console.log(chalk.red(`  Failed to approve intent: ${err.message}`));
    console.log(chalk.gray(`  Intent remains in 'pending' state.`));
  }
}

/**
 * Fix 3: rejectIntent uses transitionIntent() instead of raw UPDATE.
 */
async function rejectIntent(args, _rl) {
  const idPrefix = args[0];
  if (!idPrefix) {
    console.log(chalk.yellow('  Usage: intents reject <id-prefix> [reason]'));
    return;
  }

  const intent = await findIntent(idPrefix);
  if (!intent) return;

  if (intent.status !== 'pending') {
    console.log(chalk.yellow(`  Intent ${intent.id.slice(0, 8)}... is already ${intent.status}.`));
    return;
  }

  const reason = args.slice(1).join(' ') || null;

  const result = await transitionIntent(intent.id, 'rejected', 'board', reason);

  if (!result.success) {
    console.log(chalk.red(`  Failed to reject: ${result.error}`));
    return;
  }

  console.log(chalk.red(`  Rejected: ${intent.id.slice(0, 8)}...`));
  console.log(chalk.gray(`  Intent: ${intent.title}`));
  if (reason) console.log(chalk.gray(`  Reason: ${reason}`));
}

async function showHistory() {
  const result = await query(
    `SELECT id, agent_id, intent_type, decision_tier, title, status,
            board_feedback, created_at, reviewed_at
     FROM agent_graph.agent_intents
     WHERE status != 'pending'
     ORDER BY COALESCE(reviewed_at, created_at) DESC
     LIMIT 20`
  );

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No intent history yet.'));
    return;
  }

  console.log(chalk.bold(`\n  Recent intent history (${result.rows.length})\n`));

  for (const intent of result.rows) {
    const statusColor = {
      approved: chalk.green,
      rejected: chalk.red,
      expired: chalk.gray,
      executed: chalk.blue,
    }[intent.status] || chalk.white;

    console.log(
      `  ${intent.id.slice(0, 8)}  ` +
      statusColor(`${intent.status.padEnd(10)}`) +
      chalk.gray(`${intent.agent_id.padEnd(14)}`) +
      `${truncate(intent.title, 50)}`
    );
  }
  console.log();
}

async function showMatchRates() {
  const result = await query(
    `SELECT * FROM agent_graph.intent_match_rate ORDER BY total DESC`
  );

  if (result.rows.length === 0) {
    console.log(chalk.gray('  No intent data yet (need approved/rejected intents for match rate).'));
    return;
  }

  console.log(chalk.bold('\n  Intent Match Rates (90-day rolling, per agent + type)\n'));

  for (const row of result.rows) {
    const rate = parseFloat(row.match_rate || 0);
    const rateColor = rate >= 0.8 ? chalk.green : rate >= 0.5 ? chalk.yellow : chalk.red;
    console.log(
      `  ${row.agent_id.padEnd(20)} ` +
      chalk.gray(`${row.intent_type.padEnd(14)}`) +
      rateColor(`${(rate * 100).toFixed(1)}%`.padEnd(8)) +
      chalk.gray(`(${row.approved} approved / ${row.rejected} rejected / ${row.total} total)`)
    );
  }

  console.log();
}

// =============================================================
// Helpers
// =============================================================

async function findIntent(idPrefix) {
  const result = await query(
    `SELECT * FROM agent_graph.agent_intents WHERE id LIKE $1 ORDER BY created_at DESC LIMIT 5`,
    [idPrefix + '%']
  );

  if (result.rows.length === 0) {
    console.log(chalk.red(`  No intent found matching "${idPrefix}"`));
    return null;
  }

  if (result.rows.length > 1) {
    console.log(chalk.yellow(`  Multiple matches for "${idPrefix}":`));
    for (const r of result.rows) {
      console.log(chalk.gray(`    ${r.id} — ${r.title} [${r.status}]`));
    }
    console.log(chalk.yellow('  Please provide a longer prefix.'));
    return null;
  }

  return result.rows[0];
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

function formatRelativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimeRemaining(date) {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return chalk.red('expired');
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `${Math.floor(diff / 60_000)}m left`;
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}
