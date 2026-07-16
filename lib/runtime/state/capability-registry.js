/**
 * Capability registry: singleton Map from capability key → impl object.
 * Mirrors the lib/adapters/registry.js pattern. Products inject capabilities
 * at boot so lib/runtime/* never has to dynamic-import back into the product
 * layer (CG-1: cross-layer imports).
 *
 * Capability keys are stable strings, no globs:
 *   - 'voice/embeddings' → { embedText }
 *   - 'linear/client'    → { updateIssueStateByName, addBotComment }
 */

const capabilities = new Map();

/**
 * Register a capability implementation under a stable key.
 * @param {string} key - Capability identifier (e.g. 'voice/embeddings')
 * @param {object} impl - Implementation object exposing the capability's methods
 */
export function registerCapability(key, impl) {
  if (!key || typeof key !== 'string') {
    throw new Error('capability key must be a non-empty string');
  }
  if (!impl || typeof impl !== 'object') {
    throw new Error(`capability impl for "${key}" must be an object`);
  }
  capabilities.set(key, impl);
}

/**
 * Resolve a registered capability. Throws when the key is not registered —
 * call sites that should degrade gracefully when a capability is absent must
 * gate on hasCapability() first.
 * @param {string} key
 * @returns {object}
 */
export function getCapability(key) {
  const impl = capabilities.get(key);
  if (!impl) {
    throw new Error(`No capability registered: "${key}"`);
  }
  return impl;
}

/**
 * Probe for a capability without throwing. Use to skip optional behavior in
 * test environments or runtime modes where the product hasn't bootstrapped.
 * @param {string} key
 * @returns {boolean}
 */
export function hasCapability(key) {
  return capabilities.has(key);
}

/**
 * Drop all registrations. Tests only.
 */
export function clearCapabilities() {
  capabilities.clear();
}
