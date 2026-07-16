import { spawnCLI } from '../spawn-cli.js';

/**
 * CLI driver — thin pass-through to the existing spawnCLI() function.
 * The executor-adapter adds traceId to the result.
 *
 * @param {object} options - Same options shape as spawnCLI
 * @returns {Promise<{ costUsd: number, numTurns: number, durationMs: number, result: string, isError: boolean, error: string|null }>}
 */
export async function run(options) {
  return spawnCLI(options);
}
