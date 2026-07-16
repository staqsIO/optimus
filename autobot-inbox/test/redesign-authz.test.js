import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import {
  isJobAccessAuthorized,
  classifyRateAllowed,
  resolveStatusAccess,
} from '../src/api-routes/redesign.js';

/**
 * AuthZ + rate-limiting on the public /api/redesign/* routes (plan 019).
 *
 * These exercise the exact decision helpers the route handlers call:
 *   - isJobAccessAuthorized(req, body, meta): governs notify/status/strategy/
 *     preview. A `false` return is what the handlers translate into a 404.
 *   - classifyRateAllowed(ip): governs the public POST /classify limiter.
 *
 * Pure/deterministic (no DB, no network), mirroring redesign-security-gate.test.
 */

const JOB_TOKEN = randomBytes(32).toString('hex');
const META = { target_url: 'https://x.com', job_token: JOB_TOKEN };

// Minimal req stub. `url` carries the query string for the ?token= path.
function req({ headers = {}, url = '/api/redesign/status/job-1' } = {}) {
  return { headers, url };
}

describe('redesign job-token ownership (isJobAccessAuthorized)', () => {
  let savedSecret;
  beforeEach(() => { savedSecret = process.env.API_SECRET; });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = savedSecret;
  });

  it('DENIES an unauthenticated caller with no token (→ handler 404)', () => {
    assert.equal(isJobAccessAuthorized(req(), null, META), false);
  });

  it('DENIES a wrong token', () => {
    const r = req({ headers: { 'x-job-token': 'deadbeef' } });
    assert.equal(isJobAccessAuthorized(r, null, META), false);
  });

  it('DENIES when the job has no stored token even if the caller sends one', () => {
    const r = req({ headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(isJobAccessAuthorized(r, null, { target_url: 'https://x.com' }), false);
  });

  it('ALLOWS the correct token via x-job-token header', () => {
    const r = req({ headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(isJobAccessAuthorized(r, null, META), true);
  });

  it('ALLOWS the correct token via ?token= query string', () => {
    const r = req({ url: `/api/redesign/preview/job-1?token=${JOB_TOKEN}` });
    assert.equal(isJobAccessAuthorized(r, null, META), true);
  });

  it('ALLOWS the correct token via body.jobToken (notify)', () => {
    assert.equal(isJobAccessAuthorized(req(), { jobToken: JOB_TOKEN }, META), true);
  });

  it('ALLOWS admin (Bearer API_SECRET) to access ANY job without a token', () => {
    process.env.API_SECRET = 'super-secret-value';
    const r = req({ headers: { authorization: 'Bearer super-secret-value' } });
    assert.equal(isJobAccessAuthorized(r, null, META), true);
  });

  it('DENIES a wrong admin secret', () => {
    process.env.API_SECRET = 'super-secret-value';
    const r = req({ headers: { authorization: 'Bearer nope' } });
    assert.equal(isJobAccessAuthorized(r, null, META), false);
  });

  it('DENIES admin auth when API_SECRET is unset (no bypass)', () => {
    delete process.env.API_SECRET;
    const r = req({ headers: { authorization: 'Bearer ' } });
    assert.equal(isJobAccessAuthorized(r, null, META), false);
  });
});

describe('resolveStatusAccess (GET /status/:id authz — strict, no anon fallback)', () => {
  let savedSecret;
  beforeEach(() => {
    savedSecret = process.env.API_SECRET;
    delete process.env.API_SECRET;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = savedSecret;
  });

  // ── /status access decision ────────────────────────────────────────────────
  it('an unauthenticated caller with no token is DENIED (→ handler 404)', () => {
    assert.equal(resolveStatusAccess(req(), META), 'deny');
  });

  it('a job with NO stored token (orphaned/legacy) is DENIED for an anonymous caller', () => {
    assert.equal(resolveStatusAccess(req(), { target_url: 'https://x.com' }), 'deny');
  });

  it('a valid token is authorized', () => {
    const r = req({ headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(resolveStatusAccess(r, META), 'authorized');
  });

  it('admin (Bearer API_SECRET) is authorized', () => {
    process.env.API_SECRET = 'super-secret-value';
    const r = req({ headers: { authorization: 'Bearer super-secret-value' } });
    assert.equal(resolveStatusAccess(r, META), 'authorized');
  });

  // ── notify/strategy/preview share the exact same strict gating ────────────
  it('notify/strategy/preview stay token-gated (isJobAccessAuthorized false) for an anonymous caller', () => {
    assert.equal(isJobAccessAuthorized(req(), null, META), false);          // no token
    assert.equal(isJobAccessAuthorized(req(), { jobId: 'x' }, META), false); // notify body, no token
  });
});

describe('classify IP rate limit (classifyRateAllowed)', () => {
  it('allows under the limit and 429s (false) once the limit is exceeded', () => {
    const ip = `1.2.3.${Math.floor(Math.random() * 250)}`;
    const t0 = 1_000_000;
    // 30 allowed in the window.
    for (let i = 0; i < 30; i++) {
      assert.equal(classifyRateAllowed(ip, t0), true, `call ${i + 1} should pass`);
    }
    // 31st in the same window is rejected → handler returns 429.
    assert.equal(classifyRateAllowed(ip, t0), false, 'over-limit call must be rejected');
  });

  it('resets after the hourly window elapses', () => {
    const ip = `9.9.9.${Math.floor(Math.random() * 250)}`;
    const t0 = 5_000_000;
    for (let i = 0; i < 30; i++) classifyRateAllowed(ip, t0);
    assert.equal(classifyRateAllowed(ip, t0), false, 'saturated within the window');
    // Advance past the 1h window → counter clears.
    const later = t0 + 60 * 60 * 1000 + 1;
    assert.equal(classifyRateAllowed(ip, later), true, 'allowed again after window reset');
  });
});
