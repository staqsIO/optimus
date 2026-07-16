import chalk from 'chalk';
import { getAgentActivity, getBudgetStatus, getDailyStats } from '../../signal/briefing-generator.js';
import { getEditRate } from '../../voice/edit-tracker.js';

/**
 * Stats command: cost, throughput, autonomy metrics.
 */
export async function statsCommand() {
  const agents = await getAgentActivity();
  const budgets = await getBudgetStatus();
  const editRate = await getEditRate(14);
  const stats = await getDailyStats();

  console.log(chalk.bold('\n  System Stats'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Agent activity
  console.log(chalk.bold('\n  Agent Activity (today):'));
  console.log(chalk.gray('  Agent               Calls   Cost      Tokens     Active  Done'));
  for (const a of agents) {
    const name = a.agent_id.padEnd(20);
    const calls = String(a.calls_today).padStart(5);
    const cost = `$${parseFloat(a.cost_today_usd).toFixed(4)}`.padStart(9);
    const tokens = String(a.tokens_today).padStart(10);
    const active = String(a.active_tasks).padStart(6);
    const done = String(a.completed_today).padStart(5);
    console.log(`  ${name} ${calls} ${cost} ${tokens} ${active} ${done}`);
  }

  // Budget
  console.log(chalk.bold('\n  Budget Status:'));
  for (const b of budgets) {
    const pct = parseFloat(b.utilization_pct || 0);
    const color = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
    console.log(`  ${b.scope}: ${color(`$${parseFloat(b.spent_usd).toFixed(4)}`)} / $${parseFloat(b.allocated_usd).toFixed(2)} (${color(`${pct}%`)})`);
  }

  // Autonomy metrics
  console.log(chalk.bold('\n  Autonomy Level: L0 (Full HITL)'));
  console.log(chalk.bold('  L0 Exit Criteria:'));
  console.log(`    Drafts reviewed (14d): ${editRate.total} / 50 ${editRate.total >= 50 ? chalk.green('PASS') : chalk.gray('...')}`);
  console.log(`    Edit rate (14d):       ${(editRate.rate * 100).toFixed(1)}% (target <10%) ${editRate.rate < 0.1 ? chalk.green('PASS') : chalk.gray('...')}`);
  console.log(`    Minimum 14 days:       ${stats ? chalk.gray('tracking...') : chalk.gray('not started')}`);

  console.log();
}
