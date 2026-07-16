import { gmailTwin } from './gmail-twin.js';

/**
 * Digital-twin registry (Phase 2.4) — DEV/TEST SUBSTITUTION ONLY.
 *
 * A twin replaces a real input adapter with a deterministic, offline stand-in so
 * verification/dev runs are reproducible. Enabled per-provider via an env flag:
 *
 *   TWIN_GMAIL=replay   (also: record | mock)
 *
 * No-op when the flag is unset, so production is unaffected. This is explicitly
 * NOT a production resilience layer (a real-API outage is a circuit-breaker
 * concern, kept separate per Neo's boundary review).
 */

// Provider → twin factory. Add new providers here as twins are built.
const TWIN_FACTORIES = {
  gmail: gmailTwin,
  email: gmailTwin, // the email channel is gmail-backed today
};

/** The configured twin mode for a provider, or null when disabled. */
export function twinMode(provider) {
  const raw = process.env[`TWIN_${String(provider).toUpperCase()}`];
  if (!raw) return null;
  const mode = raw.trim().toLowerCase();
  return ['replay', 'record', 'mock'].includes(mode) ? mode : null;
}

export function isTwinEnabled(provider) {
  return twinMode(provider) !== null;
}

/**
 * Return a twin-wrapped adapter when a twin is enabled+available for the provider;
 * otherwise return the real adapter unchanged. The returned object implements the
 * same InputAdapter interface, so it still passes validateInputAdapter.
 */
export function wrapWithTwin(provider, adapter, opts = {}) {
  const mode = twinMode(provider);
  if (!mode) return adapter;
  const factory = TWIN_FACTORIES[provider];
  if (!factory) return adapter; // enabled but no twin for this provider → real adapter
  return factory(adapter, { mode, ...opts });
}
