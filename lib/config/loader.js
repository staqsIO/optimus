/**
 * Config loader shim.
 *
 * Centralizes the read path for product config files (agents.json, gates.json,
 * autonomy-rules.json, webhook-sources.json, ...) so lib/ modules don't import
 * those paths directly.
 *
 * Two modes:
 *
 *   1. Default (fallback): resolves config relative to this file at the
 *      product config dir defined by FALLBACK_BASE_DIR below. This preserves
 *      the historical behavior; existing callers need zero startup changes.
 *
 *   2. Override: a product calls setConfigBaseDir(absolutePath) at startup
 *      to redirect lookups elsewhere (e.g. a tier-neutral root config dir,
 *      or a second product's config). Must be called before any lib/ module
 *      that reads config at module load — see the eager-evaluation note
 *      below.
 *
 * Eager evaluation: many lib/ modules (guard-check, autonomy-evaluator, etc.)
 * call getConfig() at module top to populate constants. Those calls happen as
 * soon as the module is imported. If you want setConfigBaseDir() to take
 * effect, call it in the product entry point *before* any lib/ runtime module
 * is imported, or dynamically import lib/ modules after the override.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

const FALLBACK_BASE_DIR = fileURLToPath(new URL('../../autobot-inbox/config/', import.meta.url));

let _baseDir = null;

/**
 * Override the config base directory. Pass an absolute path.
 * Call before any lib/ module that reads config at module load.
 */
export function setConfigBaseDir(absolutePath) {
  if (typeof absolutePath !== 'string' || !absolutePath.length) {
    throw new TypeError('setConfigBaseDir requires a non-empty absolute path string');
  }
  _baseDir = absolutePath;
}

function activeBaseDir() {
  return _baseDir || FALLBACK_BASE_DIR;
}

/**
 * Resolve an absolute path inside the active config dir.
 *
 * Pass a bare name ('agents') and we'll add `.json`. Pass an explicit filename
 * with extension ('spec-mappings.yaml') for non-JSON resources.
 */
export function getConfigPath(name) {
  if (typeof name !== 'string' || !name.length) {
    throw new TypeError('getConfigPath requires a non-empty name');
  }
  const filename = extname(name) ? name : `${name}.json`;
  return join(activeBaseDir(), filename);
}

/**
 * Read and JSON-parse a config file. Throws on missing file or malformed JSON.
 * For YAML or other formats use getConfigPath() and parse yourself.
 */
export function getConfig(name) {
  const filepath = getConfigPath(name);
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

/**
 * Read raw file contents (utf-8). Useful for files that aren't JSON.
 */
export function readConfig(name) {
  const filepath = getConfigPath(name);
  return readFileSync(filepath, 'utf-8');
}
