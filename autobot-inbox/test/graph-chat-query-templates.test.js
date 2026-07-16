// Feature 010-A (OPT-130) — graph query-template module.
// Covers the security-critical logic without a live Neo4j: tenancy fail-closed
// (AC-3), graceful degradation (AC-4), bot filtering (AC-5), server-side param
// validation, and the origin_org token mapping. Cypher correctness (AC-1) is
// verified live against the prod graph in the rollout step.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runGraphTemplate,
  allowedOriginTokens,
  graphTemplateSpecs,
  GRAPH_TEMPLATE_NAMES,
  ROW_CAP,
} from '../../lib/graph/chat-query-templates.js';

// Regression guard (live-prod bug 2026-06-13): neo4j-driver serializes JS numbers
// as Float, but Cypher LIMIT/SKIP and duration() require Integer — a bare
// `LIMIT $cap` fails at runtime with "'25.0' is not a valid value". Unit tests
// with a fake runCypher can't catch this, so assert the source coerces with
// toInteger(). Keep this in sync if the param names change.
describe('010-A Cypher integer-safety (neo4j LIMIT/duration require Integer)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../lib/graph/chat-query-templates.js', import.meta.url)),
    'utf8',
  );
  it('never passes a bare $cap to LIMIT (must be toInteger($cap))', () => {
    assert.ok(!/LIMIT\s+\$cap\b/.test(src), 'found bare `LIMIT $cap` — wrap with toInteger($cap)');
    assert.ok(/LIMIT\s+toInteger\(\$cap\)/.test(src), 'expected `LIMIT toInteger($cap)`');
  });
  it('coerces the duration days param to an integer', () => {
    assert.ok(!/duration\(\{days:\s*\$days\}\)/.test(src), 'found bare `duration({days: $days})` — wrap with toInteger');
    assert.ok(/duration\(\{days:\s*toInteger\(\$days\)\}\)/.test(src));
  });
});
import { CURRENT_ORG_ID } from '../../lib/tenancy/scope.js';
import { getOriginOrg } from '../../lib/graph/client.js';

// neo4j-driver returns records with a .toObject(); fake that shape.
const rec = (obj) => ({ toObject: () => obj });

// A capturing fake runCypher. Returns the supplied records; records every call.
function fakeCypher(records = []) {
  const calls = [];
  const fn = async (cypher, params, opts) => {
    calls.push({ cypher, params, opts });
    return records;
  };
  return { fn, calls };
}

const up = { isGraphAvailable: () => true }; // graph "up"
const scopeOrg = { readOrgIds: [CURRENT_ORG_ID] }; // a resolved board member

describe('010-A graph query-templates — registry', () => {
  it('exposes the four spec templates', () => {
    assert.deepEqual(
      [...GRAPH_TEMPLATE_NAMES].sort(),
      ['org_people', 'person_connections', 'recent_collaborators', 'shared_context'],
    );
  });

  it('graphTemplateSpecs lists params for the 010-B tool schema', () => {
    const specs = Object.fromEntries(graphTemplateSpecs().map((s) => [s.name, s.params]));
    assert.deepEqual(specs.shared_context, ['a', 'b']);
    assert.deepEqual(specs.recent_collaborators, ['person', 'days']);
  });

  it('rejects an unknown template without touching the graph', async () => {
    const { fn, calls } = fakeCypher();
    const out = await runGraphTemplate('drop_everything', { person: 'x' }, scopeOrg, {
      ...up, runCypher: fn,
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'unknown_template');
    assert.equal(calls.length, 0);
  });
});

describe('010-A origin_org token mapping', () => {
  it('maps the local install token (self) in for a CURRENT_ORG reader', () => {
    const tokens = allowedOriginTokens([CURRENT_ORG_ID]);
    assert.ok(tokens.includes(CURRENT_ORG_ID));
    assert.ok(tokens.includes(getOriginOrg()), 'caller of current org can read locally-stamped nodes');
  });

  it('does NOT grant the local token to a foreign-only reader', () => {
    const foreign = '00000000-0000-0000-0000-000000000999';
    const tokens = allowedOriginTokens([foreign]);
    assert.ok(tokens.includes(foreign));
    assert.ok(!tokens.includes('self'), 'foreign org must not see self-stamped nodes');
  });
});

describe('010-A AC-3 tenancy (fail-closed)', () => {
  it('returns zero rows and NEVER queries when the caller has no readable org', async () => {
    const { fn, calls } = fakeCypher([rec({ name: 'Kevin' })]);
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' },
      { readOrgIds: [] }, { ...up, runCypher: fn });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reason, 'no_org_access');
    assert.equal(calls.length, 0, 'fail-closed: no graph round-trip on empty scope');
  });

  it('passes the scoped origin tokens + cap + botTypes into Cypher', async () => {
    const { fn, calls } = fakeCypher([]);
    await runGraphTemplate('org_people', { org: 'Empire Asset Finance' }, scopeOrg,
      { ...up, runCypher: fn });
    assert.equal(calls.length, 1);
    const p = calls[0].params;
    assert.ok(p.allowedOrigins.includes(CURRENT_ORG_ID));
    assert.equal(p.cap, ROW_CAP);
    assert.deepEqual(p.botTypes, ['service', 'newsletter']);
    assert.equal(p.trusted, false);
    assert.equal(calls[0].opts.readOnly, true);
  });

  it('a bypass field smuggled inside scope is IGNORED (P2: not spoofable)', async () => {
    const { fn, calls } = fakeCypher([rec({ name: 'x' })]);
    // A buggy/malicious caller puts adminBypass/trusted *inside scope* — it must
    // NOT grant access; only the explicit opts.trusted flag can.
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' },
      { readOrgIds: [], adminBypass: true, trusted: true }, { ...up, runCypher: fn });
    assert.equal(out.reason, 'no_org_access');
    assert.equal(calls.length, 0, 'scope-borne bypass must never reach the graph');
  });

  it('explicit opts.trusted (verified agent caller) may query with an empty readable-org set', async () => {
    const { fn, calls } = fakeCypher([]);
    await runGraphTemplate('person_connections', { person: 'a@b.co' },
      { readOrgIds: [] }, { ...up, runCypher: fn, trusted: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.trusted, true);
  });
});

describe('010-A AC-4 graceful degradation', () => {
  it('graph unavailable → degraded empty result, no query', async () => {
    const { fn, calls } = fakeCypher([rec({ name: 'x' })]);
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' }, scopeOrg,
      { isGraphAvailable: () => false, runCypher: fn });
    assert.equal(out.available, false);
    assert.equal(out.degraded, true);
    assert.equal(out.rows.length, 0);
    assert.equal(calls.length, 0);
  });

  it('runCypher returning null → degraded, never throws', async () => {
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' }, scopeOrg,
      { ...up, runCypher: async () => null });
    assert.equal(out.available, false);
    assert.equal(out.degraded, true);
  });

  it('runCypher throwing → degraded, never throws', async () => {
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' }, scopeOrg,
      { ...up, runCypher: async () => { throw new Error('bolt connection reset'); } });
    assert.equal(out.available, false);
    assert.equal(out.degraded, true);
    assert.equal(out.rows.length, 0);
  });
});

describe('010-A AC-5 bot filtering', () => {
  it('strips note-taker bots that slip past the contact_type filter', async () => {
    const records = [
      rec({ name: 'Kevin Durant', email: 'kevin@empire.co', tier: 'inner_circle', weight: 9, lastAt: '2026-06-01T00:00:00.000Z' }),
      rec({ name: 'tl;dv', email: 'tldv@calendar.com', tier: null, weight: 50, lastAt: '2026-06-10T00:00:00.000Z' }),
      rec({ name: 'Fireflies.ai Notetaker', email: 'fred@fireflies.ai', tier: null, weight: 7, lastAt: '2026-06-09T00:00:00.000Z' }),
    ];
    const { fn } = fakeCypher(records);
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' }, scopeOrg,
      { ...up, runCypher: fn });
    const names = out.rows.map((r) => r.name);
    assert.deepEqual(names, ['Kevin Durant']);
  });
});

describe('010-A row cap', () => {
  it('never returns more than ROW_CAP rows', async () => {
    const records = Array.from({ length: 40 }, (_, i) =>
      rec({ name: `Person ${i}`, email: `p${i}@x.co`, tier: 'active', weight: i, lastAt: null }));
    const { fn } = fakeCypher(records);
    const out = await runGraphTemplate('person_connections', { person: 'a@b.co' }, scopeOrg,
      { ...up, runCypher: fn });
    assert.ok(out.rows.length <= ROW_CAP);
  });
});

describe('010-A server-side param validation', () => {
  it('rejects a missing required param without querying', async () => {
    const { fn, calls } = fakeCypher([]);
    const out = await runGraphTemplate('person_connections', {}, scopeOrg, { ...up, runCypher: fn });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'missing_or_invalid:person');
    assert.equal(calls.length, 0);
  });

  it('shared_context requires both a and b', async () => {
    const out = await runGraphTemplate('shared_context', { a: 'eric' }, scopeOrg, { ...up, runCypher: async () => [] });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'missing_or_invalid:b');
  });

  it('recent_collaborators defaults days to 30 and clamps to 365', async () => {
    const def = fakeCypher([]);
    await runGraphTemplate('recent_collaborators', { person: 'eric' }, scopeOrg, { ...up, runCypher: def.fn });
    assert.equal(def.calls[0].params.days, 30);

    const big = fakeCypher([]);
    await runGraphTemplate('recent_collaborators', { person: 'eric', days: 99999 }, scopeOrg, { ...up, runCypher: big.fn });
    assert.equal(big.calls[0].params.days, 365);
  });

  it('recent_collaborators rejects days < 1', async () => {
    const out = await runGraphTemplate('recent_collaborators', { person: 'eric', days: 0 }, scopeOrg, { ...up, runCypher: async () => [] });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid:days');
  });
});
