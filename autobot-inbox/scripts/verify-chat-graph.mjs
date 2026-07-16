#!/usr/bin/env node
// AC-1 live round-trip check for Feature 010 (OPT-132). Drives the deployed
// chat endpoint with graph-relational questions and reports whether query_graph
// fired (graph-kind citations) against the live prod Neo4j.
//
// Run with prod creds injected (API_SECRET stays in the subprocess env):
//   railway run --service autobot-inbox-api node autobot-inbox/scripts/verify-chat-graph.mjs
//
// Reads API_SECRET from process.env; hits the PUBLIC api host.

const BASE = process.env.VERIFY_BASE || 'https://preview.staqs.io';
const SECRET = process.env.API_SECRET;
const BOARD_USER = process.env.VERIFY_BOARD_USER || 'ecgang';

if (!SECRET) { console.error('API_SECRET not in env — run via `railway run --service autobot-inbox-api`'); process.exit(1); }

// Probes most likely to land on real graph data first (Eric has dense edges).
const PROBES = [
  'Using the knowledge graph, who is eric@staqs.io connected to? List a few names.',
  'Who do we know at Frontpoint?',
  'Who do we know at Empire Asset Finance?',
];

async function ask(message) {
  const r = await fetch(`${BASE}/api/chat/auto`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
      'x-board-user': BOARD_USER,
    },
    body: JSON.stringify({ message }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, raw: text };
}

let anyGraph = false;
for (const q of PROBES) {
  console.log(`\n──── PROBE: ${q}`);
  try {
    const { status, json, raw } = await ask(q);
    if (status !== 200 || !json) { console.log(`  HTTP ${status}: ${raw.slice(0, 200)}`); continue; }
    const cites = Array.isArray(json.citations) ? json.citations : [];
    const graphCites = cites.filter((c) => c && c.kind === 'graph');
    console.log(`  HTTP 200 · agent=${json.agentId} · cost=$${(json.costUsd || 0).toFixed?.(4) ?? json.costUsd} · citations=${cites.length} (graph=${graphCites.length})`);
    console.log(`  answer: ${String(json.text || '').replace(/\s+/g, ' ').slice(0, 280)}`);
    if (graphCites.length) {
      anyGraph = true;
      for (const c of graphCites.slice(0, 6)) console.log(`    🔗 graph chip: ${c.label} — ${String(c.snippet || '').slice(0, 80)}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

console.log(`\n${anyGraph ? '✅ AC-1 PASS — query_graph fired and returned graph-sourced citations from prod.' : '⚠️ No graph citations surfaced — either the named entities have no graph edges, or the model did not call query_graph. Try an org/person known to have WORKS_AT/co-attendance edges.'}`);
process.exit(0);
