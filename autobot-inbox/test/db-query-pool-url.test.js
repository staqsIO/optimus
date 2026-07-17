// autobot-inbox/test/db-query-pool-url.test.js — Phase 2 query-pool split.
// Lives here (not under lib/) because CI (`test:ci`) only runs autobot-inbox/test/.
//
// Verifies deriveQueryPoolUrl(): the QUERY pool rides the Supabase TRANSACTION
// pooler (6543) while LISTEN stays on the SESSION pooler (5432). Pure-function
// unit test — no pg connection opened.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveQueryPoolUrl, sslOptionFor } from '../../lib/db.js';

// Representative Supabase pooler URL (session pooler, port 5432). The username
// carries the project-ref suffix per the PgBouncer convention.
const SUPA_5432 =
  'postgresql://postgres.abcdefghijklmnop:s3cr3t-pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

describe('deriveQueryPoolUrl (Phase 2 query-pool split)', () => {
  it('supabase :5432 → query URL :6543 with pgbouncer=true', () => {
    const out = deriveQueryPoolUrl(SUPA_5432, { isSupabase: true });
    const u = new URL(out);
    assert.equal(u.port, '6543', 'port should swap to the transaction pooler');
    assert.equal(
      u.hostname,
      'aws-0-us-east-1.pooler.supabase.com',
      'host must be unchanged — same pooler, different port'
    );
    assert.equal(
      u.searchParams.get('pgbouncer'),
      'true',
      'pgbouncer=true required for transaction pooling (prepared statements off)'
    );
  });

  it('preserves an already-present pgbouncer param (does not duplicate)', () => {
    const out = deriveQueryPoolUrl(`${SUPA_5432}?pgbouncer=true`, { isSupabase: true });
    const u = new URL(out);
    assert.equal(u.port, '6543');
    assert.equal(u.searchParams.getAll('pgbouncer').length, 1);
    assert.equal(u.searchParams.get('pgbouncer'), 'true');
  });

  it('DATABASE_URL_QUERY override wins verbatim', () => {
    const override =
      'postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true';
    const out = deriveQueryPoolUrl(SUPA_5432, {
      isSupabase: true,
      queryUrlOverride: override,
    });
    assert.equal(out, override, 'override must be returned byte-for-byte');
  });

  it('only swaps the authority port — a literal 5432 in the password is untouched', () => {
    // Password contains "5432" — a naive string-replace would corrupt it.
    const tricky =
      'postgresql://postgres.proj:pw5432pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
    const out = deriveQueryPoolUrl(tricky, { isSupabase: true });
    const u = new URL(out);
    assert.equal(u.port, '6543', 'authority port swapped');
    assert.equal(
      decodeURIComponent(u.password),
      'pw5432pw',
      'password containing 5432 must be preserved exactly'
    );
  });

  it('non-supabase host (localhost) is returned unchanged — no port swap', () => {
    const local = 'postgresql://app:app@localhost:5432/optimus';
    const out = deriveQueryPoolUrl(local, { isSupabase: false });
    const u = new URL(out);
    assert.equal(u.port, '5432', 'localhost port must NOT be swapped');
    assert.equal(u.hostname, 'localhost');
    assert.equal(u.searchParams.has('pgbouncer'), false, 'no pgbouncer injected for non-supabase');
  });

  it('non-supabase Railway internal host is returned unchanged', () => {
    const railway = 'postgresql://app:app@postgres.railway.internal:5432/railway';
    const out = deriveQueryPoolUrl(railway, { isSupabase: false });
    assert.equal(new URL(out).port, '5432');
  });

  it('LISTEN still uses the raw 5432 URL (the query derivation does not mutate input)', () => {
    // deriveQueryPoolUrl must be pure: passing SUPA_5432 returns a NEW 6543
    // string and the original 5432 URL the pg-listener uses is unaffected.
    const original = SUPA_5432;
    const out = deriveQueryPoolUrl(original, { isSupabase: true });
    assert.equal(new URL(original).port, '5432', 'caller-held LISTEN URL still on 5432');
    assert.equal(new URL(out).port, '6543', 'derived query URL on 6543');
    assert.notEqual(original, out);
  });

  it('supabase URL with no explicit port defaults to the transaction pooler', () => {
    // Defensive: if a Supabase URL omits the port, treat it as session-default
    // (5432) and move queries to 6543 anyway.
    const noPort =
      'postgresql://postgres.proj:pw@aws-0-us-east-1.pooler.supabase.com/postgres';
    const out = deriveQueryPoolUrl(noPort, { isSupabase: true });
    assert.equal(new URL(out).port, '6543');
  });
});

// Docker-compose fresh-clone regression (2026-07-16): DATABASE_URL host is the
// compose service name "postgres" — not localhost — so the old inline isLocal
// heuristic forced SSL against a Postgres with no TLS and boot died with
// "The server does not support SSL connections". sslOptionFor() honors an
// explicit sslmode=disable (libpq contract) as the escape hatch.
describe('sslOptionFor (SSL decision for pg pools)', () => {
  it('sslmode=disable wins even for a non-local hostname (compose service)', () => {
    assert.deepEqual(
      sslOptionFor('postgresql://postgres:postgres@postgres:5432/autobot?sslmode=disable'),
      {}
    );
  });

  it('non-local hostname without sslmode → SSL with rejectUnauthorized:false', () => {
    assert.deepEqual(
      sslOptionFor('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres'),
      { ssl: { rejectUnauthorized: false } }
    );
  });

  it('localhost / 127.0.0.1 / .railway.internal → no SSL', () => {
    for (const host of ['localhost', '127.0.0.1', 'db.railway.internal']) {
      assert.deepEqual(sslOptionFor(`postgresql://u:p@${host}:5432/db`), {});
    }
  });

  it('compose service hostname WITHOUT sslmode=disable still gets SSL (unchanged default)', () => {
    assert.deepEqual(
      sslOptionFor('postgresql://postgres:postgres@postgres:5432/autobot'),
      { ssl: { rejectUnauthorized: false } }
    );
  });

  it('empty/undefined connection string → no SSL option', () => {
    assert.deepEqual(sslOptionFor(undefined), {});
    assert.deepEqual(sslOptionFor(''), {});
  });
});
