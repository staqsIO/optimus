/**
 * STAQPRO-547 — pre-send governance scan must fail closed on unparseable model
 * output instead of silently fail-open (empty findings == clean pass).
 *
 * Covers the two route surfaces wired to lib/contracts/pre-send-check.js:
 *   POST /api/contracts/:id/pre-send-check  — propagates parseError, ok:false
 *   POST /api/contracts/:id/send            — injects a sentinel warn finding
 *                                             when the re-check parse-fails
 *
 * The preSendCheck module itself is mocked: its internal LLM-output parsing is
 * exercised by its own logic; here we assert the route-level contract that a
 * parseError result is surfaced rather than swallowed.
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks \
 *        --test --test-force-exit --test-timeout=20000 \
 *        test/contracts-pre-send-parse-fail.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- Module-level mocks (must precede importing the route module) ----

const mockQuery = mock.fn(async () => ({ rows: [] }));
// contracts.js imports { query, withAgentScope, withBoardScope } from '../db.js';
// the mock must provide EVERY named import or the module fails to load ("does not
// provide an export named ..."), which silently registered 0 tests before plan 028.
// withBoardScope is imported by contracts.js's board-scoped handlers (OPT-166
// P3-B3); the send handler under test uses withAgentScope, so withBoardScope only
// needs to exist as an export here.
// withTransaction is retained (harmless — no live ref remains) to avoid
// disturbing any legacy assertion; withAgentScope returns a scoped callable with
// a .release() method, mirroring lib/db.js (the DELETE handler's scope wrapper —
// #562 swapped it from withBoardScope so agent JWTs don't 500 on delete).
const mockWithTransaction = mock.fn(async (fn) => fn({ query: mockQuery }));
// #561: the send handler now runs its content-schema statements (draft load,
// send_overrides INSERT + backfill, drafts status UPDATE) through withAgentScope
// rather than the bare query(). The mocked scoped callable must DELEGATE to
// mockQuery so this suite's draft-load mock and the `INSERT INTO
// content.send_overrides` .calls.find() assertions still see them.
const mockWithAgentScope = mock.fn(async () => {
  const scoped = mock.fn((sql, params) => mockQuery(sql, params));
  scoped.release = mock.fn(async () => {});
  return scoped;
});
const mockWithBoardScope = mock.fn(async () => {
  const scoped = mock.fn((sql, params) => mockQuery(sql, params));
  scoped.release = mock.fn(async () => {});
  return scoped;
});
const mockPreSendCheck = mock.fn();
const mockCreateSigningRequest = mock.fn(async () => ({
  requestId: 'req-1',
  signers: [],
  expiresAt: new Date().toISOString(),
}));

mock.module('../src/db.js', {
  namedExports: { query: mockQuery, withTransaction: mockWithTransaction, withAgentScope: mockWithAgentScope, withBoardScope: mockWithBoardScope },
});

// retrieverScopeWithOrg is imported at module top from ./document-access.js —
// stub it so importing contracts.js doesn't drag in the real scope helper.
mock.module('../src/api-routes/document-access.js', {
  namedExports: { retrieverScopeWithOrg: mock.fn() },
});

mock.module('../../lib/contracts/pre-send-check.js', {
  namedExports: { preSendCheck: mockPreSendCheck },
});

mock.module('../../lib/signatures/session.js', {
  namedExports: { createSigningRequest: mockCreateSigningRequest },
});

mock.module('../../lib/signatures/notifier.js', {
  namedExports: { sendSigningEmail: mock.fn(async () => {}) },
});

const { registerContractRoutes } = await import('../src/api-routes/contracts.js');

function buildRoutes() {
  const routes = new Map();
  registerContractRoutes(routes);
  return routes;
}

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';

describe('STAQPRO-547 pre-send check fails closed on parse error', () => {
  beforeEach(() => {
    mockQuery.mock.resetCalls();
    mockPreSendCheck.mock.resetCalls();
    mockCreateSigningRequest.mock.resetCalls();
    mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
  });

  it('POST /pre-send-check propagates parseError and reports ok:false', async () => {
    mockPreSendCheck.mock.mockImplementation(async () => ({
      findings: [],
      parseError: true,
      parseErrorMsg: 'Unexpected token < in JSON at position 0',
      costUsd: 0.0003,
      model: 'claude-haiku-4-5-20251001',
      ragSkipped: true,
    }));

    const routes = buildRoutes();
    const handler = routes.get('POST /api/contracts/:id/pre-send-check');
    const res = await handler(
      { url: `/api/contracts/${DRAFT_ID}/pre-send-check`, headers: {} },
      {}
    );

    assert.equal(res.ok, false, 'parseError must not be reported as a clean pass');
    assert.equal(res.parseError, true);
    assert.match(res.parseErrorMsg, /Unexpected token/);
    assert.deepEqual(res.findings, []);
  });

  it('POST /pre-send-check reports ok:true on a normal (parsed) result', async () => {
    mockPreSendCheck.mock.mockImplementation(async () => ({
      findings: [],
      costUsd: 0.0002,
      model: 'claude-haiku-4-5-20251001',
      ragSkipped: true,
    }));

    const routes = buildRoutes();
    const handler = routes.get('POST /api/contracts/:id/pre-send-check');
    const res = await handler(
      { url: `/api/contracts/${DRAFT_ID}/pre-send-check`, headers: {} },
      {}
    );

    assert.equal(res.ok, true);
    assert.equal(res.parseError, undefined);
  });

  it('POST /send injects a sentinel warn finding when the re-check parse-fails (no block)', async () => {
    // Approved contract draft load
    mockQuery.mock.mockImplementation(async (sql) => {
      if (/FROM content\.drafts WHERE id/.test(sql)) {
        return {
          rows: [{
            id: DRAFT_ID,
            title: 'Service Agreement',
            status: 'approved',
            content_type: 'contract',
            seo_metadata: { signer_name: 'Acme', signer_email: 'acme@example.com' },
          }],
        };
      }
      return { rows: [] };
    });

    mockPreSendCheck.mock.mockImplementation(async () => ({
      findings: [],
      parseError: true,
      parseErrorMsg: 'bad json',
      costUsd: 0,
      model: 'claude-haiku-4-5-20251001',
      ragSkipped: true,
    }));

    const routes = buildRoutes();
    const handler = routes.get('POST /api/contracts/:id/send');
    // parseError yields warn (not block) → send proceeds, no override insert.
    // req.auth is required now that the handler opens withAgentScope(sub) (#561).
    await handler(
      {
        url: `/api/contracts/${DRAFT_ID}/send`,
        headers: { 'x-board-user': 'eric' },
        auth: { sub: 'eric', role: 'board', source: 'jwt' },
      },
      {}
    );

    assert.equal(mockCreateSigningRequest.mock.callCount(), 1,
      'warn-severity sentinel must NOT block a legitimate send');
    // No block findings ⇒ no send_overrides insert.
    const overrideInsert = mockQuery.mock.calls.find(
      (c) => /INSERT INTO content\.send_overrides/.test(c.arguments[0])
    );
    assert.equal(overrideInsert, undefined,
      'a warn-only sentinel should not write a send_overrides row');
  });

  it('POST /send persists the sentinel alongside a block finding (override path)', async () => {
    mockQuery.mock.mockImplementation(async (sql) => {
      if (/FROM content\.drafts WHERE id/.test(sql)) {
        return {
          rows: [{
            id: DRAFT_ID,
            title: 'Service Agreement',
            status: 'approved',
            content_type: 'contract',
            seo_metadata: { signer_name: 'Acme', signer_email: 'acme@example.com' },
          }],
        };
      }
      if (/INSERT INTO content\.send_overrides/.test(sql)) {
        return { rows: [{ id: 'override-1' }] };
      }
      return { rows: [] };
    });

    mockPreSendCheck.mock.mockImplementation(async () => ({
      findings: [{
        gate: 'G2', severity: 'block', title: 'Unlimited liability',
        excerpt: 'liability shall be unlimited', reason: 'open-ended exposure',
      }],
      parseError: true,
      parseErrorMsg: 'trailing garbage',
      costUsd: 0,
      model: 'claude-haiku-4-5-20251001',
      ragSkipped: true,
    }));

    const routes = buildRoutes();
    const handler = routes.get('POST /api/contracts/:id/send');
    await handler(
      {
        url: `/api/contracts/${DRAFT_ID}/send`,
        headers: { 'x-board-user': 'eric' },
        auth: { sub: 'eric', role: 'board', source: 'jwt' },
      },
      { override_reason: 'Reviewed manually with counsel, proceeding.' }
    );

    const overrideInsert = mockQuery.mock.calls.find(
      (c) => /INSERT INTO content\.send_overrides/.test(c.arguments[0])
    );
    assert.ok(overrideInsert, 'block finding must record a send_overrides row');
    const persisted = JSON.parse(overrideInsert.arguments[1][3]);
    const titles = persisted.map((f) => f.title);
    assert.ok(titles.includes('Unlimited liability'), 'original block finding persisted');
    assert.ok(titles.includes('Pre-send scan inconclusive'),
      'sentinel parse-error finding must be persisted alongside the block finding');
  });
});
