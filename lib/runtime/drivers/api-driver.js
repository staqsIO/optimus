/**
 * Raw API driver — placeholder for direct Anthropic API integration.
 *
 * @param {object} _options - Executor options (unused)
 * @throws {Error} Always — this driver is not yet implemented
 */
export async function run(_options) {
  throw new Error(
    'Raw API driver is not implemented. ' +
    'This is a placeholder for direct Anthropic API integration. ' +
    'Set executor_driver to "cli" in agents.json or EXECUTOR_DRIVER env var.'
  );
}
