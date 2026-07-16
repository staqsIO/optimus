import { validateInputAdapter } from './input-adapter.js';
import { wrapWithTwin } from '../twins/twin-registry.js';

/**
 * Adapter registry: singleton Map from provider string → adapter instance.
 * Registered at startup in index.js. Resolved by context-loader via message.provider.
 */

const adapters = new Map();

/**
 * Register an adapter for a provider.
 * Validates that the adapter implements the InputAdapter interface.
 * @param {string} provider - Provider key ('gmail', 'outlook', 'slack')
 * @param {import('./input-adapter.js').InputAdapter} adapter
 */
export function registerAdapter(provider, adapter) {
  if (!provider || typeof provider !== 'string') {
    throw new Error('provider must be a non-empty string');
  }
  // Phase 2.4: substitute a digital twin when TWIN_<PROVIDER> is set (dev/test
  // only). No-op when unset — the real adapter is registered unchanged. The twin
  // implements the same InputAdapter interface, so validation below still applies.
  const finalAdapter = wrapWithTwin(provider, adapter);
  const { valid, errors } = validateInputAdapter(finalAdapter);
  if (!valid) {
    throw new Error(`Invalid adapter for "${provider}": ${errors.join(', ')}`);
  }
  adapters.set(provider, finalAdapter);
}

/**
 * Get a registered adapter by provider key.
 * @param {string} provider
 * @returns {import('./input-adapter.js').InputAdapter}
 */
export function getAdapter(provider) {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new Error(`No adapter registered for provider "${provider}"`);
  }
  return adapter;
}

/**
 * Resolve the adapter for a message, using message.provider or defaulting to 'gmail'.
 * @param {Object} message - Message row from inbox.messages
 * @returns {import('./input-adapter.js').InputAdapter}
 */
export function getAdapterForMessage(message) {
  const provider = message.provider || 'gmail';
  return getAdapter(provider);
}

/**
 * Clear all registered adapters. For tests only.
 */
export function clearAdapters() {
  adapters.clear();
}

// --- Signal emission hook (STAQPRO-92) ---

/** @type {((signalType: string, payload: object, sourceAdapter: string) => Promise<object|null>)|null} */
let _signalEmitter = null;

/**
 * Set the signal emitter callback. Called by the flow engine at startup.
 * @param {(signalType: string, payload: object, sourceAdapter: string) => Promise<object|null>} emitter
 */
export function setSignalEmitter(emitter) {
  _signalEmitter = emitter;
}

/**
 * Emit an adapter signal. Returns null if no flow engine is configured (graceful no-op).
 * @param {string} signalType - e.g. 'email.received', 'slack.message', 'webhook.payload'
 * @param {object} payload
 * @param {string} sourceAdapter - provider key
 * @returns {Promise<object|null>}
 */
export async function emitAdapterSignal(signalType, payload, sourceAdapter) {
  if (!_signalEmitter) return null;
  return _signalEmitter(signalType, payload, sourceAdapter);
}

/**
 * Clear the signal emitter. For tests only.
 */
export function clearSignalEmitter() {
  _signalEmitter = null;
}
