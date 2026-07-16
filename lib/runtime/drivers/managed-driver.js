/**
 * Managed Agents driver — placeholder for future Claude Managed Agents API.
 *
 * @param {object} _options - Executor options (unused)
 * @throws {Error} Always — this driver is not yet implemented
 */
export async function run(_options) {
  throw new Error(
    'Managed Agents driver is not implemented. ' +
    'This is a placeholder for future Claude Managed Agents API integration. ' +
    'Set executor_driver to "cli" in agents.json or EXECUTOR_DRIVER env var.'
  );
}
