import chalk from 'chalk';
import { createWorkItem } from '../../runtime/state-machine.js';
import { getConfig } from '../../../../lib/config/loader.js';

const agentsConfig = getConfig('agents');
const researchDefaults = agentsConfig.agents['executor-research'].research;

/**
 * Research command: create a deep research workstream.
 * Usage: research <topic>
 *
 * Creates a workstream work_item assigned to executor-research with
 * research_type='deep_research' and a research_plan in metadata.
 * The M1 satellite (or local agent) picks it up and runs the iterative loop.
 */
export async function researchCommand(args, _rl) {
  const topic = args.join(' ');

  if (!topic) {
    console.log(chalk.yellow('  Usage: research <topic>'));
    console.log(chalk.gray('  Example: research agent swarm coordination protocols'));
    return;
  }

  const item = await createWorkItem({
    type: 'workstream',
    title: `Deep Research: ${topic}`,
    description: `Iterative web research on: ${topic}`,
    createdBy: 'board',
    assignedTo: 'executor-research',
    priority: 1,
    budgetUsd: researchDefaults.maxCostPerResearchUsd,
    metadata: {
      research_type: 'deep_research',
      research_plan: {
        objective: topic,
        hypotheses: [],
        focus_areas: [topic],
        constraints: {
          max_iterations: researchDefaults.maxIterationsPerSession,
          max_cost_usd: researchDefaults.maxCostPerResearchUsd,
        },
      },
    },
  });

  console.log(chalk.green(`  Research workstream created: ${item.id}`));
  console.log(chalk.gray(`  Topic: ${topic}`));
  console.log(chalk.gray(`  Budget: $${researchDefaults.maxCostPerResearchUsd.toFixed(2)} | Max iterations: ${researchDefaults.maxIterationsPerSession}`));
  console.log(chalk.gray('  Assigned to executor-research — will start on next agent tick.'));
}
