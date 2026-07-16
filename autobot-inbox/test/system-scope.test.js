/**
 * System scope (STAQPRO-263 Bucket 2) — tenancy.is_system() + withSystemScope().
 *
 * The always-on runtime read paths (agent-loop, task graph, context-loader, the
 * gmail/calendar/tldv/research pollers, audit writers, ~40 HTTP read routes) are
 * not tenant principals — they process work for ALL orgs. After the STAQPRO-263
 * pool flip, a bare query() from those paths carries no app.user/app.org_ids and
 * tenancy.visible() fail-closes every row. withSystemScope() stamps
 * app.role='system' so the Tier-0 tenancy.is_system() branch (sql/199) admits the
 * cross-org read — and records the open in an append-only ledger.
 *
 * Three hardening properties are the whole point, so they are the whole test:
 *
 *   (A) Guard token — setAgentContext refuses role='system' unless handed the
 *       module-private SYSTEM_ROLE_GUARD (which only withSystemScope holds). The
 *       full-bypass value is mechanically unreachable from any other caller.
 *   (B) Frozen allow-list — withSystemScope rejects an actor id absent from
 *       SYSTEM_ACTORS, before any DB work (deny by default).
 *   (C) Function logic + audit-on-open — is_system()/visible(NULL,NULL) are FALSE
 *       by default and TRUE only inside a system scope, and opening a scope writes
 *       exactly one audit.system_scope_opens row in the same transaction.
 *
 * These assertions are engine-agnostic (function logic + JS guards), so they hold
 * on PGlite AND real Postgres. The LIVE enforcement proof — that under the
 * non-superuser autobot_agent role RLS actually bites and a non-system connection
 * cannot read cross-org rows — runs on disposable docker pgvector in the
 * env-gated rls path, exactly as Bucket 1a's counterparties proof did. PGlite
 * connects as a superuser (BYPASSRLS), so it cannot demonstrate the deny half.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { setAgentContext, withSystemScope } from '../../lib/db.js';

let query;

before(async () => {
  ({ query } = await getDb());
});

describe('system scope — (A) guard token on setAgentContext', () => {
  it('rejects role="system" without the module-private guard token', async () => {
    // The check fires before any client.query(), so a throwing fake client proves
    // no DB round-trip happened.
    const fakeClient = { query: () => { throw new Error('must not reach query'); } };
    await assert.rejects(
      setAgentContext(fakeClient, 'agent-loop', 'system'),
      /reserved for withSystemScope|missing guard token/,
      'role=system without the guard token must be refused at the boundary'
    );
  });

  it('rejects role="system" when opts carries a wrong/forged guard value', async () => {
    const fakeClient = { query: () => { throw new Error('must not reach query'); } };
    await assert.rejects(
      setAgentContext(fakeClient, 'agent-loop', 'system', { __systemGuard: Symbol('not-the-guard') }),
      /reserved for withSystemScope|missing guard token/,
      'a forged guard token must not unlock role=system'
    );
  });
});

describe('system scope — (B) frozen actor allow-list', () => {
  it('rejects an actor id not in SYSTEM_ACTORS, before any DB work', async () => {
    await assert.rejects(
      withSystemScope('totally-unknown-actor'),
      /unknown system actor|allow-list|deny-by-default/,
      'withSystemScope must deny an actor absent from the frozen allow-list'
    );
  });

  it('rejects a prototype-polluting key (hasOwnProperty guard)', async () => {
    // Guards the allow-list lookup against inherited Object.prototype keys.
    await assert.rejects(
      withSystemScope('toString'),
      /unknown system actor|allow-list|deny-by-default/,
      'inherited prototype keys must not satisfy the allow-list'
    );
  });
});

describe('system scope — (C) function logic + audit-on-open', () => {
  it('is_system()/visible(NULL,NULL) are FALSE with no scope (fail-closed default)', async () => {
    const r = await query(`
      SELECT tenancy.is_system()                    AS sys,
             tenancy.visible(NULL::uuid, NULL::uuid) AS vis
    `);
    assert.equal(r.rows[0].sys, false, 'is_system() must be FALSE when app.role is unset');
    assert.equal(r.rows[0].vis, false, 'Tier-0 must NOT widen the default posture');
  });

  it('is_system()/visible(NULL,NULL) are TRUE inside a system scope', async () => {
    const scoped = await withSystemScope('agent-loop');
    try {
      assert.equal(scoped.identitySource, 'system', 'scopedQuery.identitySource must be "system"');
      assert.equal(scoped.agentId, 'agent-loop', 'scopedQuery.agentId must be the system actor');
      const r = await scoped(`
        SELECT tenancy.is_system()                    AS sys,
               tenancy.visible(NULL::uuid, NULL::uuid) AS vis,
               current_setting('app.role', true)       AS role
      `);
      assert.equal(r.rows[0].role, 'system', 'app.role must be stamped "system"');
      assert.equal(r.rows[0].sys, true, 'is_system() must be TRUE under system scope');
      assert.equal(r.rows[0].vis, true, 'Tier-0 must admit the cross-org read under system scope');
    } finally {
      await scoped.release();
    }
  });

  it('opening a system scope writes exactly one audit.system_scope_opens row (with reason)', async () => {
    const scoped = await withSystemScope('audit-writer', { reason: 'system-scope-test' });
    try {
      // Same transaction as the open — the audit row is visible to read-back.
      const r = await scoped(`
        SELECT system_actor, reason, backend_pid, txid
        FROM audit.system_scope_opens
        WHERE reason = 'system-scope-test'
        ORDER BY id DESC
        LIMIT 1
      `);
      assert.equal(r.rows.length, 1, 'the open must record an audit row');
      assert.equal(r.rows[0].system_actor, 'audit-writer', 'ledger must record the actor');
      assert.equal(r.rows[0].reason, 'system-scope-test', 'ledger must record the reason');
      assert.ok(r.rows[0].backend_pid != null, 'ledger must stamp backend_pid');
      assert.ok(r.rows[0].txid != null, 'ledger must stamp txid');
    } finally {
      await scoped.release();
    }
  });

  it('the audit ledger is append-only (UPDATE/DELETE are blocked by trigger)', async () => {
    // Seed a row inside a system scope, then prove it cannot be mutated. The
    // immutability trigger raises regardless of role, so we can attempt the
    // mutation on the base connection.
    const scoped = await withSystemScope('graph', { reason: 'immutability-probe' });
    try {
      await scoped(`SELECT 1`); // ensure the open (and its audit row) committed on release
    } finally {
      await scoped.release();
    }
    await assert.rejects(
      query(`UPDATE audit.system_scope_opens SET reason = 'tampered' WHERE reason = 'immutability-probe'`),
      /append-only|immutable|not allowed/i,
      'UPDATE on the audit ledger must be rejected by the immutability trigger'
    );
    await assert.rejects(
      query(`DELETE FROM audit.system_scope_opens WHERE reason = 'immutability-probe'`),
      /append-only|immutable|not allowed/i,
      'DELETE on the audit ledger must be rejected by the immutability trigger'
    );
  });
});
