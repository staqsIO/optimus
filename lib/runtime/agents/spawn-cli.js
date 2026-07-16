import { spawn, execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { redactSecrets } from '../log-redactor.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/spawn-cli');

/**
 * Shared CLI spawner for Claude Code CLI and Gemini CLI.
 *
 * Exported API:
 *   spawnCLI(opts) → { costUsd, numTurns, durationMs, result, isError, error }
 *   checkCliCapacity(backend) → { running, max, available, atCapacity }
 *
 * Design: P1 (deny by default env allowlist), P4 (boring: if/else, no registry).
 */

const SIGKILL_GRACE_MS = 5_000;
const STALL_DETECT_MS = 90_000;
const MAX_RATE_LIMIT_RETRIES = 8; // ~40-60s of Gemini 429 retries before circuit-breaking
const MAX_CLAUDE_CONCURRENCY = parseInt(process.env.MAX_CLAUDE_CONCURRENCY || '4', 10);
const SLOT_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // max 5min waiting for a CLI slot

// ── Claude CLI concurrency semaphore (RC3) ──────────────────────────────
// Enforces MAX_CLAUDE_CONCURRENCY at the process level. Advisory-only
// checkCliCapacity() logs warnings but spawns anyway; this actually blocks.
let _activeClaudeSessions = 0;
const _slotWaiters = []; // queue of { resolve, timer }

function acquireCliSlot(label, agentTag) {
  if (_activeClaudeSessions < MAX_CLAUDE_CONCURRENCY) {
    _activeClaudeSessions++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    log.info(`[${agentTag || 'spawn-cli'}] ${label || 'cli'}: Waiting for CLI slot (${_activeClaudeSessions}/${MAX_CLAUDE_CONCURRENCY} active, ${_slotWaiters.length + 1} queued)`);
    waiter.timer = setTimeout(() => {
      const idx = _slotWaiters.indexOf(waiter);
      if (idx !== -1) _slotWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for CLI slot after ${SLOT_WAIT_TIMEOUT_MS / 1000}s`));
    }, SLOT_WAIT_TIMEOUT_MS);
    _slotWaiters.push(waiter);
  });
}

function releaseCliSlot() {
  _activeClaudeSessions = Math.max(0, _activeClaudeSessions - 1);
  if (_slotWaiters.length > 0) {
    const waiter = _slotWaiters.shift();
    clearTimeout(waiter.timer);
    _activeClaudeSessions++;
    waiter.resolve();
  }
}

// P1: deny by default — only explicitly listed env keys pass through
const CLAUDE_ENV_KEYS = [
  'PATH', 'HOME', 'XDG_CONFIG_HOME',
  'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_ENV', 'LANG', 'TERM',
];
const GEMINI_ENV_KEYS = [
  // Note: GOOGLE_API_KEY and NANOBANANA_API_KEY are NOT here — those are only
  // needed by the non-agentic spawnGeminiCLI() in executor-redesign, not here.
  // Add them via extraEnvKeys if a Gemini agentic session needs them.
  'PATH', 'HOME', 'XDG_CONFIG_HOME',
  'NODE_ENV', 'LANG', 'TERM',
];

// C2 (Linus): Keys that must never pass through extraEnv (P2: infrastructure enforces).
// Callers must never add these — this is the enforcement layer.
const EXTRA_ENV_DENYLIST = new Set([
  'ANTHROPIC_API_KEY',  // forces CLI onto API billing, not subscription
  'DATABASE_URL',        // DB connection string — agents must not have it
  'GOOGLE_API_KEY',      // billing credential — must not leak to subprocesses
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/**
 * Extract the last valid JSON line from NDJSON stream-json output.
 * The final line in Claude Code's stream-json is the result summary.
 */
function extractLastJsonLine(stdout) {
  const lines = stdout.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      JSON.parse(lines[i]);
      return lines[i];
    } catch { /* not valid JSON, try previous line */ }
  }
  return stdout; // fallback to full string (will throw in caller)
}

function resolveBinary(backend) {
  if (backend === 'gemini') {
    return process.env.GEMINI_BIN
      || ['/opt/homebrew/bin/gemini', '/usr/local/bin/gemini'].find(p => existsSync(p))
      || 'gemini';
  }
  return process.env.CLAUDE_BIN
    || ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(p => existsSync(p))
    || 'claude';
}

function buildArgs(backend, opts) {
  if (backend === 'gemini') {
    const args = [
      '-p', opts.prompt,
      '--model', opts.model || 'gemini-2.5-pro',
      '--approval-mode', 'auto_edit',
      '--output-format', 'json',
    ];
    for (const tool of (opts.allowedTools || [])) {
      args.push('--allowed-tools', tool);
    }
    for (const ext of (opts.extensions || [])) {
      args.push('-e', ext);
    }
    for (const server of (opts.allowedMcpServers || [])) {
      args.push('--allowed-mcp-server-names', server);
    }
    return args;
  }

  // Claude
  const outputFormat = opts.streamEvents ? 'stream-json' : 'json';
  const args = [
    '-p', opts.prompt,
    '--output-format', outputFormat,
    ...(opts.streamEvents ? ['--verbose'] : []),
    '--model', opts.model || 'sonnet',
    '--max-budget-usd', String(opts.maxBudgetUsd || 2.00),
    '--max-turns', String(opts.maxTurns || 30),
    '--permission-mode', opts.permissionMode || 'acceptEdits',
    '--no-session-persistence',
  ];
  if (opts.systemPrompt) {
    // appendSystemPrompt=true → --append-system-prompt (adds to CLAUDE.md system prompt)
    // default → --system-prompt (replaces system prompt)
    const flag = opts.appendSystemPrompt ? '--append-system-prompt' : '--system-prompt';
    args.push(flag, opts.systemPrompt);
  }
  for (const tool of (opts.allowedTools || ['Read', 'Write', 'Bash(node *)'])) {
    args.push('--allowedTools', tool);
  }
  // MCP config path is added by _spawnOnce after writing the temp file
  if (opts._mcpConfigPath) {
    args.push('--mcp-config', opts._mcpConfigPath);
  }
  return args;
}

function buildEnv(backend, opts) {
  const baseKeys = backend === 'gemini' ? GEMINI_ENV_KEYS : CLAUDE_ENV_KEYS;
  const env = {};
  for (const key of [...baseKeys, ...(opts.extraEnvKeys || [])]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Swap to fallback subscription token if primary is rate-limited (Claude only).
  // This runs AFTER the allowlist loop (which copies the primary token) and
  // BEFORE extraEnv, so the primary token gets correctly overridden.
  if (opts._useFallbackToken && process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK;
  }
  // Explicit env overrides (e.g. GH_TOKEN from getGitHubToken()).
  // C2 (Linus): Enforce denylist — block keys that would defeat P1 security boundaries.
  if (opts.extraEnv) {
    for (const [key, val] of Object.entries(opts.extraEnv)) {
      if (EXTRA_ENV_DENYLIST.has(key)) {
        log.warn(`Blocked extraEnv key "${key}" — denied by P1 boundary`);
        continue;
      }
      env[key] = val;
    }
  }
  return env;
}

/**
 * @throws {SyntaxError} if stdout is not valid JSON
 */
function parseOutput(backend, stdout, durationMs, isStreamJson = false) {
  // stream-json: NDJSON lines, last line is the summary result object
  const toParse = isStreamJson ? extractLastJsonLine(stdout) : stdout;
  const parsed = JSON.parse(toParse);
  if (backend === 'gemini') {
    return {
      costUsd: 0, // subscription — no per-token cost
      numTurns: parsed.stats?.model?.turns ?? 0,
      durationMs: parsed.stats?.session?.duration ?? durationMs,
      isError: !!parsed.error,
      result: parsed.response ?? '',
      error: parsed.error ?? null,
    };
  }
  return {
    costUsd: parsed.cost_usd ?? parsed.total_cost_usd ?? 0,
    numTurns: parsed.num_turns ?? 0,
    durationMs: parsed.duration_ms ?? durationMs,
    isError: parsed.is_error || false,
    result: parsed.result ?? '', // use ?? not || to preserve empty-string results
    error: null,
  };
}

/**
 * Gemini has no --max-turns CLI flag — write maxSessionTurns to settings file.
 * Called before spawning when backend='gemini' and maxTurns is set.
 *
 * Known limitation (C3 Linus): concurrent Gemini spawns with different maxTurns
 * race on this shared file. In practice this doesn't happen — Gemini is only used
 * for the generate pass (one per redesign job), which never runs concurrently.
 * The timeout is the primary budget enforcement mechanism for Gemini (per design).
 */
function configureGeminiMaxTurns(maxTurns) {
  if (!maxTurns) return;
  const settingsDir = join(process.env.HOME || '/root', '.gemini');
  const settingsPath = join(settingsDir, 'settings.json');
  try {
    mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
    settings.maxSessionTurns = maxTurns;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    log.warn(`Failed to write Gemini maxSessionTurns: ${err.message}`);
  }
}

/**
 * Count currently running Claude CLI processes on this machine.
 * Returns { running, max, available, atCapacity }.
 * For Gemini: always returns unlimited (subscription, no concurrency cap).
 */
export function checkCliCapacity(backend = 'claude') {
  if (backend === 'gemini') {
    return { running: 0, max: Infinity, available: Infinity, atCapacity: false };
  }
  try {
    // Q2 (Linus): use execFileSync (no shell) to avoid pgrep self-matching via shell pipeline
    const stdout = execFileSync('pgrep', ['-f', 'claude.*--output-format'], {
      encoding: 'utf-8', timeout: 5000,
    });
    const running = stdout.trim().split('\n').filter(Boolean).length;
    return {
      running,
      max: MAX_CLAUDE_CONCURRENCY,
      available: Math.max(0, MAX_CLAUDE_CONCURRENCY - running),
      atCapacity: running >= MAX_CLAUDE_CONCURRENCY,
    };
  } catch (err) {
    // pgrep exits 1 when no processes match — that's 0 running sessions, not an error
    if (err.status === 1) {
      return { running: 0, max: MAX_CLAUDE_CONCURRENCY, available: MAX_CLAUDE_CONCURRENCY, atCapacity: false };
    }
    return { running: 0, max: MAX_CLAUDE_CONCURRENCY, available: MAX_CLAUDE_CONCURRENCY, atCapacity: false };
  }
}

/**
 * Core subprocess spawner — shared logic for both backends.
 * Returns normalized { costUsd, numTurns, durationMs, result, isError, error }.
 */
async function _spawnOnce(backend, opts) {
  const tag = opts.label || backend;
  const agentTag = opts.agentTag || 'spawn-cli';

  // RC3: Enforce Claude CLI concurrency with semaphore (not just advisory logging).
  // Gemini is unlimited — skip the semaphore entirely.
  if (backend === 'claude') {
    await acquireCliSlot(tag, agentTag);
  }

  const capacity = checkCliCapacity(backend);
  if (backend === 'claude') {
    log.info(`[${agentTag}] ${tag}: CLI slot acquired (semaphore: ${_activeClaudeSessions}/${MAX_CLAUDE_CONCURRENCY}, OS: ${capacity.running} procs)`);
  }

  if (backend === 'gemini' && opts.maxTurns) {
    configureGeminiMaxTurns(opts.maxTurns);
  }

  // MCP server config — write to tmpdir (outside any git worktree) so it can't
  // leak into PRs. Cleaned up in close/error handlers below.
  let mcpTempPath = null;
  if (opts.mcpConfig && Object.keys(opts.mcpConfig).length > 0) {
    mcpTempPath = join(tmpdir(), `.mcp-workshop-${Date.now()}.json`);
    writeFileSync(mcpTempPath, JSON.stringify({ mcpServers: opts.mcpConfig }, null, 2));
    opts = { ...opts, _mcpConfigPath: mcpTempPath };
  }

  return new Promise((resolve) => {
    const bin = resolveBinary(backend);
    const args = buildArgs(backend, opts);
    const env = buildEnv(backend, opts);
    const workDir = opts.workDir || opts.cwd;
    const effectiveTimeout = opts.timeoutMs || 20 * 60 * 1000;
    const startTime = Date.now();

    const child = spawn(bin, args, {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks = [];
    const stderrChunks = [];
    let lastOutputTime = Date.now();
    let stallWarned = false;
    let rateLimitHits = 0;
    let lineBuf = ''; // line buffer for stream-json event parsing

    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      lastOutputTime = Date.now();

      // Stream-json: parse NDJSON events and emit via onEvent callback
      if (opts.streamEvents && opts.onEvent) {
        lineBuf += chunk.toString('utf-8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop(); // keep incomplete last line in buffer
        for (const line of lines) {
          if (line.trim()) {
            try { opts.onEvent(JSON.parse(line)); } catch { /* skip malformed lines */ }
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      lastOutputTime = Date.now();
      stallWarned = false;
      const line = chunk.toString('utf-8').trim();
      if (line) log.info(`[${agentTag}] ${tag}: ${redactSecrets(line)}`);

      // Rate-limit circuit breaker (Gemini only) — kill early on repeated 429s
      // instead of letting the Gemini CLI retry indefinitely for 20 minutes.
      if (backend === 'gemini' && /429|MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|quota/i.test(line)) {
        rateLimitHits++;
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          log.warn(`[${agentTag}] ${tag}: Rate limit circuit breaker — ${rateLimitHits} consecutive 429s, killing process`);
          child.kill('SIGTERM');
        }
      } else if (line && backend === 'gemini') {
        rateLimitHits = 0; // reset on non-429 output — model is doing real work
      }
    });

    // Stall detector — warn if no output for 90s (likely queued for subscription slot)
    const stallCheck = setInterval(() => {
      const silentMs = Date.now() - lastOutputTime;
      if (silentMs > STALL_DETECT_MS && !stallWarned) {
        stallWarned = true;
        const cap = checkCliCapacity(backend);
        log.warn(`[${agentTag}] ${tag}: No output for ${Math.round(silentMs / 1000)}s — likely queued (${cap.running}/${cap.max} sessions active)`);
      }
    }, 30_000);

    let killTimer;
    let exited = false;
    const timer = setTimeout(() => {
      log.warn(`[${agentTag}] ${tag} timed out (${effectiveTimeout / 1000}s), sending SIGTERM`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    }, effectiveTimeout);

    child.on('close', (code) => {
      exited = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(stallCheck);
      if (mcpTempPath) try { unlinkSync(mcpTempPath); } catch {}
      if (backend === 'claude') releaseCliSlot();
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

      // Rate-limit circuit breaker — return clear error instead of parsing empty/partial output
      if (backend === 'gemini' && rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
        resolve({
          isError: true, result: '', costUsd: 0, numTurns: 0, durationMs,
          error: `Rate limit circuit breaker: ${rateLimitHits} consecutive 429 errors from ${opts.model || 'gemini'}`,
        });
        return;
      }

      if (!stdout) {
        // Check stderr for rate limit before returning generic error (Claude only)
        if (backend === 'claude' && stderr && /hit your limit|rate.?limit/i.test(stderr)) {
          resolve({ isError: true, result: '', error: stderr, costUsd: 0, numTurns: 0, durationMs });
          return;
        }
        if (stderr) log.error(`[${agentTag}] ${tag} stderr: ${redactSecrets(stderr)}`);
        resolve({ isError: true, result: '', error: `${backend} CLI exited with code ${code}`, costUsd: 0, numTurns: 0, durationMs });
        return;
      }

      try {
        resolve(parseOutput(backend, stdout, durationMs, !!opts.streamEvents));
      } catch {
        if (backend === 'claude' && /hit your limit|rate.?limit/i.test(stdout)) {
          resolve({ isError: true, result: '', error: stdout.slice(0, 200), costUsd: 0, numTurns: 0, durationMs });
          return;
        }
        log.error(`[${agentTag}] ${tag} returned non-JSON (exit ${code}): ${stdout.slice(0, 200)}`);
        resolve({ isError: true, result: '', error: `Non-JSON CLI output (exit ${code})`, costUsd: 0, numTurns: 0, durationMs });
      }
    });

    // C1 (Linus): clear killTimer here too — if the main timer fires (setting killTimer)
    // and THEN the child emits 'error', killTimer would be left dangling.
    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(stallCheck);
      if (mcpTempPath) try { unlinkSync(mcpTempPath); } catch {}
      if (backend === 'claude') releaseCliSlot();
      resolve({ isError: true, result: '', error: err.message, costUsd: 0, numTurns: 0, durationMs: Date.now() - startTime });
    });
  });
}

/**
 * Spawn a CLI session (agentic, multi-turn) for the given backend.
 *
 * @param {object} opts
 * @param {string} [opts.backend='claude'] - 'claude' | 'gemini'
 * @param {string} opts.prompt - User prompt (for Gemini: prepend system prompt here)
 * @param {string} [opts.systemPrompt] - System prompt (Claude only; Gemini: null, prepend to prompt)
 * @param {boolean} [opts.appendSystemPrompt] - If true, use --append-system-prompt (Claude only)
 * @param {string} [opts.workDir] - Working directory (also accepts cwd for compat)
 * @param {number} [opts.maxBudgetUsd] - Max spend in USD (Claude only)
 * @param {string[]} [opts.allowedTools] - Backend-native tool names
 * @param {string[]} [opts.extensions] - Gemini extensions to load (e.g. ['stitch'])
 * @param {string[]} [opts.allowedMcpServers] - Gemini MCP server names to allow
 * @param {number} [opts.maxTurns] - Max agent turns
 * @param {number} [opts.timeoutMs] - Wall-clock timeout
 * @param {string} [opts.label] - Log prefix
 * @param {string} [opts.agentTag] - Log tag for the calling agent
 * @param {string[]} [opts.extraEnvKeys] - Additional process.env keys to pass through
 * @param {object} [opts.extraEnv] - Explicit env overrides (keys in EXTRA_ENV_DENYLIST are blocked)
 * @param {string} [opts.model] - Model override
 * @param {Object} [opts.mcpConfig] - MCP server config (written to .mcp-workshop.json, passed via --mcp-config)
 * @param {boolean} [opts.streamEvents] - Use stream-json output format and emit events via onEvent (Claude only)
 * @param {function} [opts.onEvent] - Callback for stream-json events: (event: object) => void
 * @returns {Promise<{ costUsd, numTurns, durationMs, result, isError, error }>}
 */
export function spawnCLI(opts) {
  const backend = opts.backend || 'claude';

  if (backend === 'gemini') {
    return _spawnOnce(backend, opts);
  }

  // Claude: retry with fallback subscription token if primary is rate-limited.
  // Q5 (Linus): The retry calls _spawnOnce directly (not spawnCLI), so the result
  // does NOT pass through this .then() again — no infinite retry loop possible.
  return _spawnOnce('claude', opts).then((result) => {
    const errText = result.error || (result.isError && result.result) || '';
    if (errText && /hit your limit|rate.?limit/i.test(errText) && process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK) {
      const tag = opts.label || 'cli';
      const agentTag = opts.agentTag || 'spawn-cli';
      log.info(`[${agentTag}] ${tag}: Primary subscription rate-limited, switching to fallback token`);
      return _spawnOnce('claude', { ...opts, _useFallbackToken: true });
    }
    return result;
  });
}
