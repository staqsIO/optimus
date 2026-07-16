// ============================================================
// Production preflight — required environment keys (Plan 030 / #474)
// Infrastructure-enforced (P2), deny-by-default (P1), fail-fast.
// ============================================================
//
// autobot-inbox reads ~200 unique `process.env.*` keys, but only a small core
// is genuinely required for the runtime to function *correctly* in production.
// Historically a mis-provisioned production deploy would silently degrade — a
// missing DATABASE_URL falls back to ephemeral in-process PGlite; a missing LLM
// key surfaces only when the first agent tick fails — with no single, loud
// signal at boot. This preflight turns that silent degradation into one
// readable error that lists everything missing at once.
//
// Scope discipline (mirrors model-armor-preflight.js): the HARD gate fires ONLY
// in production. Dev, test, and CI boot are never hard-failed — they receive a
// concise warning at most (P6: do not break the humans running the system
// locally, and do not break CI). The M1 runner and the api/ingestion processes
// share the same production signal, so the gate behaves identically everywhere.
//
// Two tiers, deliberately:
//   REQUIRED    — the runtime cannot function without it in production. Missing
//                 in production ⇒ THROW (fail-fast). Kept intentionally narrow:
//                 only what index.js / runner.js already treat as boot-critical.
//   RECOMMENDED — security-relevant or integration-critical, but injected
//                 differently across deploys (JWT PEMs via *_PEM or *_PATH, ops
//                 secrets, secondary LLM providers). Missing in production ⇒
//                 loud WARN, never a hard-fail. This honors the plan's STOP
//                 condition: do not hard-fail a deploy that injects a key at a
//                 different layer — warn first, ratchet to required later.

/**
 * REQUIRED keys — production boot is refused when any is missing.
 * Under demo mode (synthetic emails, PGlite) none of these apply.
 *
 * - ANTHROPIC_API_KEY — Claude-family provider (executor-research CLI sessions,
 *   the single-provider demo overlay, and any tier still mapped to Anthropic);
 *   index.js already hard-requires it (non-demo).
 * - OPENROUTER_API_KEY — the OSS-model provider the high-volume tiers now route
 *   through (classification/orchestrator/codegen via agents.json). Without it
 *   every busy-tier agent tick fails lazily at first invocation instead of
 *   loudly at boot. Prod already provisions it (OpenRouter was load-bearing for
 *   orchestrator/strategist pre-swap), so requiring it here is fail-closed, not
 *   a new obligation. Forkers must supply their own — we do not subsidize tokens.
 *   Demo mode (LLM_SINGLE_PROVIDER / DEMO_MODE) empties this list, so an
 *   Anthropic-key-only evaluation boot is unaffected.
 * - DATABASE_URL — production must connect to the shared Postgres task graph;
 *   without it db.js silently falls back to ephemeral PGlite (demo-only).
 *   runner.js already hard-requires it unconditionally.
 */
const REQUIRED_KEYS = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DATABASE_URL'];

/**
 * RECOMMENDED keys — missing in production produces a loud warning, not a
 * failure. Each entry is satisfied if ANY of its `keys` is set (covers the
 * PEM-vs-PATH injection split). `label` explains the operational impact.
 */
const RECOMMENDED_KEYS = [
  { keys: ['AGENT_JWT_KEY_PEM', 'AGENT_JWT_KEY_PATH'], label: 'agent JWT signing (agent identity / scoped tokens)' },
  { keys: ['BOARD_JWT_KEY_PEM'], label: 'board JWT signing (board-workstation auth)' },
  { keys: ['CREDENTIALS_ENCRYPTION_KEY'], label: 'at-rest encryption for stored OAuth credentials' },
  { keys: ['API_SECRET'], label: 'ops/admin API authentication' },
  { keys: ['CRON_SECRET'], label: 'scheduled-job endpoint authentication' },
  { keys: ['GEMINI_API_KEY'], label: 'Gemini provider (strategist / architect tiers)' },
  { keys: ['OPENAI_API_KEY'], label: 'OpenAI provider (embeddings / RAG search)' },
];

/**
 * Assert that the required environment keys are present before the runtime
 * boots. Fail-fast (throws) only in production and only for REQUIRED keys.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.nodeEnv]  - production signal (defaults to process.env.NODE_ENV)
 * @param {boolean} [opts.demoMode] - demo mode uses synthetic data + PGlite; skips REQUIRED
 * @param {object}  [opts.env]      - env source to read (defaults to process.env; injectable for tests)
 * @param {{warn: Function}} [opts.logger] - warning sink (defaults to console)
 * @returns {{ ok: true, skipped?: string, warnings: string[] }}
 * @throws  {Error} when production + non-demo + one or more REQUIRED keys are missing
 */
export function assertRequiredEnvReady({
  nodeEnv = process.env.NODE_ENV,
  demoMode = false,
  env = process.env,
  logger = console,
} = {}) {
  const isProduction = nodeEnv === 'production';

  const requiredKeys = demoMode ? [] : REQUIRED_KEYS;
  const missingRequired = requiredKeys.filter((k) => !env[k]);

  // Recommended checks only matter in production; each group is satisfied by any
  // one of its alternative keys being set.
  const missingRecommended = isProduction
    ? RECOMMENDED_KEYS.filter((group) => !group.keys.some((k) => env[k]))
    : [];

  const warnings = [];

  // Non-production (dev/test/CI): never hard-fail. Surface a single concise
  // warning if a REQUIRED key is absent so a local operator sees the gap,
  // without breaking their boot.
  if (!isProduction) {
    if (missingRequired.length > 0) {
      const msg =
        '[preflight:env] Missing required env vars (non-production, not fatal): ' +
        missingRequired.join(', ') +
        '. Copy .env.example to .env and fill them in for full functionality.';
      warnings.push(msg);
      logger.warn(msg);
    }
    return { ok: true, skipped: 'not-production', warnings };
  }

  // Production: warn loudly (but do not fail) on missing RECOMMENDED keys.
  if (missingRecommended.length > 0) {
    const lines = missingRecommended.map(
      (g) => `  - ${g.keys.join(' or ')} — ${g.label}`
    );
    const msg =
      '[preflight:env] WARNING: recommended production env vars are unset ' +
      '(degraded functionality, not blocking boot):\n' +
      lines.join('\n');
    warnings.push(msg);
    logger.warn(msg);
  }

  // Production: fail fast on missing REQUIRED keys — list them all at once.
  // Never log the values themselves, only the key names.
  if (missingRequired.length > 0) {
    throw new Error(
      '[preflight:env] Refusing to start in production: required env vars are ' +
        'missing — ' +
        missingRequired.join(', ') +
        '. The runtime cannot function correctly without these ' +
        '(LLM provider + shared Postgres task graph). Set them in the ' +
        'environment (see .env.example), or run in demo mode.'
    );
  }

  return { ok: true, warnings };
}

// Exposed for tests / tooling that want to introspect the contract without
// re-deriving it.
export const REQUIRED_ENV_KEYS = REQUIRED_KEYS;
export const RECOMMENDED_ENV_KEYS = RECOMMENDED_KEYS;
