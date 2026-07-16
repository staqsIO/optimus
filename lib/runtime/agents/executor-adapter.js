import { createChildLogger } from '../../logger.js';
import crypto from 'node:crypto';
import { getConfig } from '../../config/loader.js';

const log = createChildLogger({ module: 'executor-adapter' });

// ── Agent config loader (lazy, non-blocking) ──────────────────────────
let _agentConfig = null;

async function getAgentConfig() {
  if (_agentConfig) return _agentConfig;
  try {
    _agentConfig = getConfig('agents');
    return _agentConfig;
  } catch { /* config unavailable — fall through to defaults */ }
  return {};
}

/**
 * Resolve the executor driver for an agent.
 * Priority: agent config executor_driver > EXECUTOR_DRIVER env var > 'cli'
 */
async function getDriverForAgent(agentTag) {
  const config = await getAgentConfig();
  if (config && agentTag) {
    // agents.json is keyed by agent tag
    const agentDef = config[agentTag];
    if (agentDef?.executor_driver) return agentDef.executor_driver;
  }
  return process.env.EXECUTOR_DRIVER || 'cli';
}

// ── Driver registry (lazy dynamic import) ─────────────────────────────
const DRIVER_MAP = {
  cli: () => import('../drivers/cli-driver.js'),
  managed: () => import('../drivers/managed-driver.js'),
  api: () => import('../drivers/api-driver.js'),
};

/**
 * Run an executor via the appropriate driver.
 *
 * Reads `options.agentTag` to look up `executor_driver` from agents.json,
 * falls back to `EXECUTOR_DRIVER` env var, then default `cli`.
 *
 * Returns normalized shape:
 *   { costUsd, numTurns, durationMs, result, isError, error, traceId }
 *
 * @param {object} options - Same options shape as spawnCLI (passed through unchanged)
 * @returns {Promise<{ costUsd: number, numTurns: number, durationMs: number, result: string, isError: boolean, error: string|null, traceId: string }>}
 */
export async function runExecutor(options) {
  const traceId = crypto.randomUUID();
  const agentTag = options.agentTag || null;

  let driver;
  try {
    driver = await getDriverForAgent(agentTag);
  } catch {
    driver = 'cli';
  }

  log.info({ agentTag, driver, traceId }, 'Dispatching to executor');

  const loader = DRIVER_MAP[driver];
  if (!loader) {
    return {
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
      result: '',
      isError: true,
      error: `Unknown executor driver: "${driver}". Valid drivers: ${Object.keys(DRIVER_MAP).join(', ')}`,
      traceId,
    };
  }

  try {
    const mod = await loader();
    const result = await mod.run(options);
    const out = { ...result, traceId };

    // Persist trace for audit chain (P3: transparency by structure)
    log.info({
      traceId,
      agentTag,
      driver,
      model: options.model || 'unknown',
      costUsd: out.costUsd || 0,
      durationMs: out.durationMs || 0,
      numTurns: out.numTurns || 0,
      isError: false,
    }, 'Executor completed');

    return out;
  } catch (err) {
    log.error({ agentTag, driver, traceId, err: err.message }, 'Executor driver error');
    return {
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
      result: '',
      isError: true,
      error: err.message,
      traceId,
    };
  }
}
