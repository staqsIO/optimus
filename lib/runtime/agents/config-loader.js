/**
 * Shared config loader — merges disk agents.json with DB overrides.
 *
 * DB overrides (agent_graph.agent_config_overrides) survive Railway deploys.
 * Disk config is the git-committed baseline. DB wins on conflict.
 *
 * Cached for 30s to avoid hammering DB on every poll cycle.
 * Call clearConfigCache() after writing overrides so the next read is fresh.
 */

import { createLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
const log = createLogger('runtime/config-loader');

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 30_000; // 30s

function loadFromDisk() {
  return getConfig('agents');
}

/**
 * Load agent config merged from disk (agents.json) + DB overrides.
 * DB overrides win. Cached for 30s.
 */
export async function loadMergedConfig() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  // 1. Load base config from disk
  const config = loadFromDisk();

  // 2. Load DB overrides
  try {
    const { query } = await import('../../db.js');

    // Agent-level overrides (model, temperature, maxTokens, enabled)
    const overrides = await query(
      `SELECT agent_id, field, value FROM agent_graph.agent_config_overrides`
    );
    for (const row of overrides.rows) {
      if (config.agents[row.agent_id]) {
        setNestedValue(config.agents[row.agent_id], row.field, row.value);
      }
    }

    // Model-level overrides (added/modified models)
    const modelOverrides = await query(
      `SELECT model_key, config FROM agent_graph.model_config_overrides`
    );
    for (const row of modelOverrides.rows) {
      const override = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
      config.models[row.model_key] = { ...(config.models[row.model_key] || {}), ...override };
    }
  } catch (err) {
    log.warn('Failed to load DB overrides, using disk only:', err.message);
  }

  _cache = config;
  _cacheTime = now;
  return config;
}

/** Clear the config cache (call after writing overrides). */
export function clearConfigCache() {
  _cache = null;
  _cacheTime = 0;
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {};
    current = current[keys[i]];
  }
  // Parse JSON values if they look like JSON
  try {
    current[keys[keys.length - 1]] = JSON.parse(value);
  } catch {
    current[keys[keys.length - 1]] = value;
  }
}
