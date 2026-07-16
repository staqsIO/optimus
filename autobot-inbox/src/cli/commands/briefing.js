import chalk from 'chalk';
import { getLatestBriefing, getDailyStats } from '../../signal/briefing-generator.js';

/**
 * Briefing command: show today's daily briefing.
 */
export async function briefingCommand() {
  const stats = await getDailyStats();
  const briefing = await getLatestBriefing();

  console.log(chalk.bold('\n  Daily Briefing'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  if (stats) {
    console.log(chalk.bold('  Today:'));
    console.log(`    Emails received:  ${stats.emails_received_today}`);
    console.log(`    Emails triaged:   ${stats.emails_triaged_today}`);
    console.log(`    Action required:  ${chalk.red(stats.action_required_today)}`);
    console.log(`    Needs response:   ${chalk.yellow(stats.needs_response_today)}`);
    console.log(`    Drafts created:   ${stats.drafts_created_today}`);
    console.log(`    Drafts approved:  ${chalk.green(stats.drafts_approved_today)}`);
    console.log(`    Drafts edited:    ${chalk.yellow(stats.drafts_edited_today)}`);
    console.log(`    Cost:             $${parseFloat(stats.cost_today_usd || 0).toFixed(4)}`);
    console.log();
    console.log(chalk.bold('  Queue:'));
    console.log(`    Awaiting triage:  ${stats.emails_awaiting_triage}`);
    console.log(`    Awaiting review:  ${stats.drafts_awaiting_review}`);
    console.log(`    Upcoming deadlines: ${stats.upcoming_deadlines}`);
    console.log();
    console.log(chalk.bold('  L0 Exit Criteria (14-day rolling):'));
    console.log(`    Edit rate:        ${stats.edit_rate_14d_pct}% (target: <10%)`);
    console.log(`    Drafts reviewed:  ${stats.drafts_reviewed_14d} / 50`);
  }

  if (briefing) {
    console.log();
    console.log(chalk.bold(`  Briefing (${briefing.briefing_date}):`));
    console.log(chalk.white(`    ${briefing.summary}`));

    const actionItems = typeof briefing.action_items === 'string'
      ? JSON.parse(briefing.action_items) : briefing.action_items;
    if (actionItems?.length > 0) {
      console.log(chalk.bold('\n  Action Items:'));
      for (const item of actionItems) {
        console.log(chalk.yellow(`    - ${item}`));
      }
    }

    const signals = typeof briefing.signals === 'string'
      ? JSON.parse(briefing.signals) : briefing.signals;
    if (signals?.length > 0) {
      console.log(chalk.bold('\n  Signals:'));
      for (const signal of signals) {
        console.log(`    - ${signal}`);
      }
    }
  } else {
    console.log(chalk.gray('\n  No briefing generated yet today.'));
  }

  console.log();
}
