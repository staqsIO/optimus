import chalk from 'chalk';
import { emitHalt, clearHalt, isHalted } from '../../runtime/event-bus.js';

/**
 * Halt command: emergency stop all agents.
 * Fail-closed: immediately blocks all new task processing.
 */
export async function haltCommand(args) {
  const already = await isHalted();
  if (already) {
    console.log(chalk.yellow('  System is already halted. Use "resume" to restart.'));
    return;
  }

  const reason = args.join(' ') || 'Manual halt from CLI';
  await emitHalt(reason);
  console.log(chalk.red(`  HALT issued: ${reason}`));
  console.log(chalk.red('  All agents will stop processing new tasks.'));
}

/**
 * Resume command: clear halt and resume operations.
 */
export async function resumeCommand() {
  const halted = await isHalted();
  if (!halted) {
    console.log(chalk.gray('  System is not halted.'));
    return;
  }

  const cleared = await clearHalt();
  console.log(chalk.green(`  Resumed. ${cleared} halt signal(s) cleared.`));
}
