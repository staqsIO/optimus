import chalk from 'chalk';
import { createWorkItem } from '../../runtime/state-machine.js';

/**
 * Directive command: create a board directive (top-level task).
 * P6: Board injects strategy via directives in the task graph.
 */
export async function directiveCommand(args, _rl) {
  const title = args.join(' ');

  if (!title) {
    console.log(chalk.yellow('  Usage: directive <title>'));
    console.log(chalk.gray('  Example: directive Prioritize investor emails this week'));
    return;
  }

  const item = await createWorkItem({
    type: 'directive',
    title,
    description: `Board directive: ${title}`,
    createdBy: 'board',
    priority: 0,
    metadata: { source: 'cli' },
  });

  console.log(chalk.green(`  Directive created: ${item.id}`));
  console.log(chalk.gray(`  Title: ${title}`));
}
