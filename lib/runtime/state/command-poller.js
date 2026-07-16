import { query } from '../../db.js';
import { createLogger } from '../../logger.js';

const log = createLogger('command-poller');

const POLL_INTERVAL_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 8_000;

/**
 * Drain agent_graph.runner_commands for this runner_id and act on each row.
 *
 * Currently supports `restart` — clean-shutdown agent loops, then exit non-zero
 * so the process supervisor (launchd on M1, Railway healthchecker on Railway)
 * respawns. `pause` and `resume` are accepted by the schema but consumed-only
 * (logged + no-op) until the agent-loop suppression hooks land.
 *
 * Pairs with POST /api/runners/:id/restart and the Runners dashboard button
 * (STAQPRO-290 Phase 2).
 *
 * @param {string} runnerId — this process's runner_id (matches /runners rollup)
 * @param {{ stop?: () => Promise<void> | void }[]} agents — agents to drain on restart
 * @returns {NodeJS.Timeout} interval handle (so the caller can clear on shutdown)
 */
export function startCommandPoller(runnerId, agents) {
  if (!runnerId) {
    log.warn('command poller skipped — no runner_id');
    return null;
  }
  return setInterval(async () => {
    try {
      const result = await query(
        `UPDATE agent_graph.runner_commands
            SET consumed_at = now(), consumed_by_pid = $2
          WHERE id IN (
            SELECT id FROM agent_graph.runner_commands
             WHERE runner_id = $1 AND consumed_at IS NULL
             ORDER BY issued_at ASC
             LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, command, issued_by, issued_at`,
        [runnerId, String(process.pid)]
      );
      if (result.rows.length === 0) return;
      const cmd = result.rows[0];
      log.info(`command ${cmd.command} from ${cmd.issued_by} (issued ${cmd.issued_at}) — acting`);

      if (cmd.command === 'restart') {
        try {
          const drainPromises = (agents || [])
            .map(a => Promise.resolve().then(() => a?.stop?.()));
          await Promise.race([
            Promise.allSettled(drainPromises),
            new Promise(r => setTimeout(r, SHUTDOWN_DRAIN_MS)),
          ]);
        } finally {
          log.info('exiting for restart');
          process.exit(2);
        }
      }

      log.warn(`command "${cmd.command}" not yet implemented — consumed without action`);
    } catch (err) {
      log.warn({ err }, 'command poll failed');
    }
  }, POLL_INTERVAL_MS);
}
