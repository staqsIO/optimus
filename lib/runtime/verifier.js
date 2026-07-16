/**
 * Context-isolated verifier primitive — OPT-3.
 *
 * DESIGN: "build once, use twice"
 *
 * The verifier judges a target against upfront success criteria. The `verify`
 * function signature is:
 *
 *   verify({ successCriteria, target, maxIterations, iterationTimeoutMs })
 *
 * It receives ONLY:
 *   - successCriteria: the upfront specification (what "done" looks like)
 *   - target: an opaque handle describing the surface to probe (CLI | API | Playwright stub)
 *   - maxIterations / iterationTimeoutMs: bounds to prevent infinite loops
 *
 * IMPL-BLINDNESS — what this layer does and does NOT guarantee:
 *   verify() has no `implementation` parameter and never reads source/diff/env,
 *   so the *data* of the implementation is absent from this call site. But this
 *   is blindness by CONVENTION, not an isolation boundary: verify() runs
 *   in-process, and a `check` function (criterion.check) is a closure that can
 *   capture anything its author can reach. True context-isolation — the verifier
 *   AUTHOR being a separate context from the implementer — is a property of how
 *   the criteria are produced, not of this function. For USE SITE 1 (flow gate)
 *   the target is the flow's own output, which is genuinely impl-free; for USE
 *   SITE 2 (dev SOP) blindness holds only if a different context authored the
 *   criteria. Do not read this as a sandbox.
 *
 * USE SITE 1 — Flow/runner task gate:
 *   After all steps complete, flow-engine calls gateFlowCompletion() which
 *   wraps verify(). The flow only transitions to 'completed' if verify()
 *   returns { passed: true }. See: gateFlowCompletion() below.
 *
 * USE SITE 2 — Dev-side check:
 *   Any developer (or tool) can call devCheck() — which is just verify() —
 *   directly with criteria + a CLI or API target to confirm an artifact
 *   satisfies its spec before merging. See: devCheck() below.
 *
 * PLUGGABLE TARGETS:
 *   The target object carries a `type` field ('api' | 'cli' | 'playwright' | 'mock').
 *   probeTarget() dispatches to the appropriate probe strategy. Playwright
 *   is a stub (heavy dependency) — the CONTRACT is what Liotta/Eric review,
 *   not the browser driver.
 *
 * BOUNDING:
 *   maxIterations (default 5) caps retries. iterationTimeoutMs (default 10s)
 *   caps each probe. Both must be respected before the caller can call this
 *   a verifier — a verifier that can run forever is a safety hazard (P1).
 */

import { createLogger } from '../logger.js';

const log = createLogger('runtime/verifier');

// ---------------------------------------------------------------------------
// Default bounds (P1: deny by default — these are conservative)
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ITERATIONS = 5;
export const DEFAULT_ITERATION_TIMEOUT_MS = 10_000; // 10 seconds per probe

// ---------------------------------------------------------------------------
// Gate result shapes
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GateResult
 * @property {string} criterion  - The criterion text
 * @property {boolean} passed    - Did this gate pass?
 * @property {string} [reason]   - Why it passed or failed
 */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} passed             - All gates passed
 * @property {number} iterations          - How many probe iterations were run
 * @property {GateResult[]} gateResults   - Per-criterion verdicts from the last iteration
 * @property {string} [failureMode]       - Summary of what failed (set when passed=false)
 */

// ---------------------------------------------------------------------------
// Target probe — pluggable dispatch
// ---------------------------------------------------------------------------

/**
 * Probe the target surface and return an observation object.
 *
 * @param {object} target  - { type: 'api'|'cli'|'playwright'|'mock', ...config }
 * @param {AbortSignal} signal - timeout signal
 * @returns {Promise<object>} observation — shape depends on target type
 */
async function probeTarget(target, signal) {
  if (!target || !target.type) {
    throw new Error('verifier: target must have a `type` field (api | cli | playwright | mock)');
  }

  switch (target.type) {
    case 'api': {
      // API target: call an HTTP endpoint and return the parsed response.
      // The URL, method, headers, and body are part of the target — not the impl.
      const { url, method = 'GET', headers = {}, body } = target;
      if (!url) throw new Error('verifier api target: `url` is required');
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      let responseBody;
      try {
        responseBody = await resp.json();
      } catch {
        responseBody = await resp.text().catch(() => '');
      }
      return { status: resp.status, ok: resp.ok, body: responseBody };
    }

    case 'cli': {
      // CLI target: spawn a command and return { exitCode, stdout, stderr }.
      // The command is part of the target — not the implementation source.
      const { command, args = [], cwd, env } = target;
      if (!command) throw new Error('verifier cli target: `command` is required');
      const { spawnSync } = await import('child_process');
      const result = spawnSync(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        encoding: 'utf-8',
        timeout: DEFAULT_ITERATION_TIMEOUT_MS,
      });
      return {
        exitCode: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      };
    }

    case 'playwright': {
      // Playwright stub — the CONTRACT is what matters for Liotta/Eric review.
      // Real Playwright integration plugs in here without touching verify().
      // A real implementation would:
      //   1. Launch a browser page
      //   2. Navigate to target.url
      //   3. Execute target.assertions (array of { selector, text?, visible? })
      //   4. Return { assertions: [{ selector, passed, actual }] }
      log.warn('verifier: playwright target is a stub — returning empty observation');
      return {
        _stub: true,
        url: target.url,
        note: 'Playwright target is a stub. Wire the real driver here without changing verify().',
      };
    }

    case 'mock': {
      // Test/dev target: the observation IS the target.observation field.
      // Used to inject controlled observations in tests without spawning real
      // processes or HTTP servers.
      if (target.observation === undefined) {
        throw new Error('verifier mock target: `observation` is required');
      }
      if (typeof target.observation === 'function') {
        return target.observation();
      }
      return target.observation;
    }

    default:
      throw new Error(`verifier: unknown target type "${target.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Criterion evaluation — deterministic where possible, no LLM by default
// ---------------------------------------------------------------------------

/**
 * Evaluate a single criterion against an observation.
 *
 * Criteria are plain objects with a `check` field (function or spec object).
 * Using a function keeps criteria deterministic — no LLM cost, no latency,
 * no non-determinism for checkable conditions. LLM judging is opt-in via
 * criterion.judgeWithLLM = true (reserved for future extension without
 * breaking the verify() signature — see DESIGN NOTE below).
 *
 * DESIGN NOTE on LLM judging:
 *   The verify() signature is intentionally LLM-free by default. When an LLM
 *   judge is needed (e.g., "does the output sound professional?"), the criterion
 *   should carry { judgeWithLLM: true, prompt: "..." } and the evaluation engine
 *   should call lib/llm/provider.js. This extension point exists in the
 *   criterion object, not in verify() itself, preserving the primitive's
 *   impl-blind contract.
 *
 * Criterion shapes:
 *   - { text, check: (obs) => boolean|{ passed, reason } }   — function gate
 *   - { text, field, operator, value }                        — declarative gate
 *     operators: eq, neq, gt, gte, lt, lte, contains, matches, exists
 *
 * @param {object} criterion
 * @param {object} observation
 * @returns {GateResult}
 */
function evaluateCriterion(criterion, observation) {
  const text = criterion.text || criterion.metric || JSON.stringify(criterion);

  // Function-based gate (most flexible)
  if (typeof criterion.check === 'function') {
    try {
      const result = criterion.check(observation);
      if (typeof result === 'boolean') {
        return { criterion: text, passed: result, reason: result ? 'check returned true' : 'check returned false' };
      }
      if (typeof result === 'object' && 'passed' in result) {
        return { criterion: text, passed: !!result.passed, reason: result.reason || '' };
      }
      return { criterion: text, passed: !!result, reason: String(result) };
    } catch (err) {
      return { criterion: text, passed: false, reason: `check threw: ${err.message}` };
    }
  }

  // Declarative gate: { field, operator, value }
  if (criterion.field) {
    const actual = criterion.field.split('.').reduce((obj, key) => obj?.[key], observation);
    const expected = criterion.value ?? criterion.threshold;
    const op = criterion.operator || '>=';

    let passed = false;
    let reason = '';

    switch (op) {
      case 'eq':   case '==': passed = actual === expected; reason = `${actual} === ${expected}`; break;
      case 'neq':  case '!=': passed = actual !== expected; reason = `${actual} !== ${expected}`; break;
      case 'gt':   case '>':  passed = actual > expected;   reason = `${actual} > ${expected}`;  break;
      case 'gte':  case '>=': passed = actual >= expected;  reason = `${actual} >= ${expected}`; break;
      case 'lt':   case '<':  passed = actual < expected;   reason = `${actual} < ${expected}`;  break;
      case 'lte':  case '<=': passed = actual <= expected;  reason = `${actual} <= ${expected}`; break;
      case 'exists':          passed = actual !== undefined && actual !== null; reason = `${criterion.field} ${passed ? 'exists' : 'absent'}`; break;
      case 'contains':        passed = String(actual || '').includes(String(expected)); reason = `"${actual}" contains "${expected}"`; break;
      case 'matches': {
        // ReDoS guard: criteria can arrive as JSONB from the DB (flow_definitions
        // .success_criteria), so a hostile/serialized pattern is untrusted input.
        // Bound the pattern length and isolate construction/exec failures so a
        // pathological regex fails the gate (P1) rather than hanging the engine.
        const pat = String(expected ?? '');
        if (pat.length > 512) { passed = false; reason = `pattern too long (${pat.length} > 512)`; break; }
        try {
          passed = new RegExp(pat).test(String(actual || ''));
          reason = `"${actual}" matches /${pat}/`;
        } catch (e) {
          passed = false; reason = `invalid regex: ${e.message}`;
        }
        break;
      }
      default:                passed = false; reason = `unknown operator "${op}"`;
    }

    return { criterion: text, passed, reason };
  }

  // Unknown criterion shape — fail closed (P1: deny by default)
  return {
    criterion: text,
    passed: false,
    reason: 'criterion has neither a `check` function nor a `field` declarative spec — failing closed',
  };
}

// ---------------------------------------------------------------------------
// verify() — the primitive
// ---------------------------------------------------------------------------

/**
 * Context-isolated verifier. Receives ONLY the success criteria + the target.
 * Never receives the implementation — structural impl-blindness by signature.
 *
 * @param {object} opts
 * @param {Array<object>} opts.successCriteria      - Array of criterion objects
 * @param {object} opts.target                      - Probe target: { type, ...config }
 * @param {number} [opts.maxIterations]             - Max probe iterations (default 5)
 * @param {number} [opts.iterationTimeoutMs]        - Per-iteration timeout ms (default 10s)
 * @returns {Promise<VerifyResult>}
 */
export async function verify({ successCriteria, target, maxIterations, iterationTimeoutMs }) {
  if (!Array.isArray(successCriteria) || successCriteria.length === 0) {
    throw new Error('verifier: successCriteria must be a non-empty array');
  }

  const maxIter = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS;

  if (maxIter < 1 || maxIter > 100) {
    throw new Error(`verifier: maxIterations must be between 1 and 100 (got ${maxIter})`);
  }

  let iterations = 0;
  let lastGateResults = [];

  for (let i = 0; i < maxIter; i++) {
    iterations++;

    // Probe the target surface — each probe is independent + time-bounded
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let observation;
    try {
      observation = await probeTarget(target, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        log.warn(`verifier iteration ${i + 1}: probe timed out after ${timeoutMs}ms`);
        lastGateResults = successCriteria.map((c) => ({
          criterion: c.text || c.metric || JSON.stringify(c),
          passed: false,
          reason: `probe timed out after ${timeoutMs}ms`,
        }));
        continue;
      }
      log.warn(`verifier iteration ${i + 1}: probe error: ${err.message}`);
      lastGateResults = successCriteria.map((c) => ({
        criterion: c.text || c.metric || JSON.stringify(c),
        passed: false,
        reason: `probe error: ${err.message}`,
      }));
      continue;
    } finally {
      clearTimeout(timer);
    }

    // Evaluate all criteria against this observation
    lastGateResults = successCriteria.map((c) => evaluateCriterion(c, observation));
    const allPassed = lastGateResults.every((g) => g.passed);

    log.info(`verifier iteration ${i + 1}/${maxIter}: ${allPassed ? 'PASS' : 'FAIL'} (${lastGateResults.filter((g) => !g.passed).length} failing gates)`);

    if (allPassed) {
      return { passed: true, iterations, gateResults: lastGateResults };
    }
  }

  // Exhausted iterations without all passing
  const failingGates = lastGateResults.filter((g) => !g.passed);
  const failureMode = failingGates
    .map((g) => `[${g.criterion}] ${g.reason}`)
    .join('; ');

  return {
    passed: false,
    iterations,
    gateResults: lastGateResults,
    failureMode,
  };
}

// ---------------------------------------------------------------------------
// Flow-engine seam — USE SITE 1
// ---------------------------------------------------------------------------

/**
 * Gate a flow execution's `completed` transition on verify().
 *
 * Call this after all steps complete, before writing `status = 'completed'`.
 *
 * Design: flow_definition optionally carries `success_criteria` JSONB
 * (migration 170 adds this column). The flow output (outputPayload) IS the
 * observation — the verifier sees ONLY the output and the criteria, never the
 * step implementations.
 *
 * If verify returns { passed: false }, do NOT write 'completed'. Instead write
 * 'verification_failed' and surface failureMode for retry/board review.
 *
 * Integration pattern (in flow-engine executeFlow, after the step loop):
 *
 *   import { gateFlowCompletion } from '../verifier.js';
 *
 *   const gateResult = await gateFlowCompletion({
 *     successCriteria: flowDef.success_criteria,
 *     outputPayload: lastOutput,
 *   });
 *   if (!gateResult.passed) {
 *     await this.db.query(
 *       `UPDATE agent_graph.flow_executions
 *        SET status = 'verification_failed', error = $2, completed_at = now()
 *        WHERE id = $1`,
 *       [execution.id, gateResult.failureMode],
 *     );
 *     return;
 *   }
 *   // normal 'completed' write follows
 *
 * @param {object} opts
 * @param {Array<object>|null} opts.successCriteria  - From flow_definition.success_criteria
 * @param {object} opts.outputPayload                - The flow's final output (observation)
 * @param {number} [opts.maxIterations]
 * @param {number} [opts.iterationTimeoutMs]
 * @returns {Promise<VerifyResult>}
 */
export async function gateFlowCompletion({ successCriteria, outputPayload, maxIterations, iterationTimeoutMs }) {
  if (!Array.isArray(successCriteria) || successCriteria.length === 0) {
    // No criteria → pass through (avoids breaking existing flows without criteria)
    return { passed: true, iterations: 0, gateResults: [] };
  }

  // The target is 'mock' — the flow's own output IS the observation.
  // The verifier evaluates criteria against the output without any access to
  // the implementation steps that produced it.
  const target = {
    type: 'mock',
    observation: outputPayload ?? {},
  };

  // A static mock observation cannot change between probes, so re-iterating is a
  // guaranteed no-op — default to a single pass. (verify()'s multi-iteration loop
  // only earns its keep for externally-changing targets, e.g. an async API
  // converging to ready.) Callers may still override explicitly.
  return verify({
    successCriteria,
    target,
    maxIterations: maxIterations ?? 1,
    iterationTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Dev-side check — USE SITE 2
// ---------------------------------------------------------------------------

/**
 * Dev-side check: the SAME verify() primitive, available for development use.
 * No wrapper magic — devCheck is an alias that makes the intent explicit.
 *
 * Example (mock target — offline, no server needed):
 *   import { devCheck } from '../../lib/runtime/verifier.js';
 *   const result = await devCheck({
 *     successCriteria: [
 *       { text: 'quality_score >= 0.85', field: 'quality_score', operator: '>=', value: 0.85 },
 *       { text: 'has id', field: 'id', operator: 'exists' },
 *     ],
 *     target: { type: 'mock', observation: { quality_score: 0.92, id: 'abc123' } },
 *   });
 *   if (!result.passed) throw new Error(result.failureMode);
 *
 * Example (API target):
 *   const result = await devCheck({
 *     successCriteria: [{ text: 'API returns 200', field: 'status', operator: 'eq', value: 200 }],
 *     target: { type: 'api', url: 'http://localhost:3001/api/health' },
 *   });
 *
 * Example (CLI target):
 *   const result = await devCheck({
 *     successCriteria: [{ text: 'exit 0', field: 'exitCode', operator: 'eq', value: 0 }],
 *     target: { type: 'cli', command: 'node', args: ['--version'] },
 *   });
 *
 * @param {object} opts - Same signature as verify()
 * @returns {Promise<VerifyResult>}
 */
export async function devCheck(opts) {
  return verify(opts);
}
