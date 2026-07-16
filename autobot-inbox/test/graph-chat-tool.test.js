// Feature 010-B (OPT-132) — query_graph chat tool wiring.
// Tenancy correctness lives in graph-chat-query-templates.test.js (010-A); this
// covers the chat-side wiring: graph rows → kind:'graph' citation chips, and the
// executeChatTool dispatch (fail-closed on no scope, graceful degradation). No
// live Neo4j: the graph is unavailable in the test env, which is what we assert.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatGraphCitations, executeChatTool } from '../src/commands/agent-chat.js';
import { CURRENT_ORG_ID } from '../../lib/tenancy/scope.js';

describe('010-B formatGraphCitations', () => {
  it('formats person rows into kind:graph chips', () => {
    const chips = formatGraphCitations(
      [{ name: 'Kevin Durant', email: 'kevin@empire.co', tier: 'inner_circle', lastAt: '2026-06-01T00:00:00.000Z' }],
      'person_connections',
    );
    assert.equal(chips.length, 1);
    assert.equal(chips[0].kind, 'graph');
    assert.match(chips[0].label, /Kevin Durant/);
    assert.match(chips[0].snippet, /kevin@empire\.co/);
  });

  it('puts the org in the label for org_people rows', () => {
    const chips = formatGraphCitations([{ name: 'Jane', email: 'jane@x.co', org: 'Empire Asset Finance' }], 'org_people');
    assert.match(chips[0].label, /Empire Asset Finance/);
  });

  it('renders a shared_context row as one connection chip', () => {
    const chips = formatGraphCitations(
      [{ connections: ['THREADED_WITH'], sharedOrgs: ['Acme'], weight: 4 }],
      'shared_context',
    );
    assert.equal(chips.length, 1);
    assert.equal(chips[0].kind, 'graph');
    assert.match(chips[0].snippet, /THREADED_WITH/);
    assert.match(chips[0].snippet, /Acme/);
  });

  it('caps chips at 25', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `P${i}`, email: `p${i}@x.co` }));
    assert.ok(formatGraphCitations(rows, 'person_connections').length <= 25);
  });
});

describe('010-B executeChatTool query_graph wiring', () => {
  it('fails closed (no retriever scope) with parseable JSON, never throws', async () => {
    const out = await executeChatTool('query_graph', { template: 'person_connections', person: 'x' }, null);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.match(parsed.message, /scope/i);
  });

  it('degrades gracefully when the graph is unavailable', async () => {
    const out = await executeChatTool('query_graph',
      { template: 'person_connections', person: 'x' }, { ownerId: 'u', readOrgIds: [CURRENT_ORG_ID] });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.equal(typeof parsed.message, 'string');
  });

  it('rejects an unknown template as an error result, not a throw', async () => {
    const out = await executeChatTool('query_graph', { template: 'nope' }, { readOrgIds: [CURRENT_ORG_ID] });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.match(parsed.message, /unknown_template/);
  });
});
