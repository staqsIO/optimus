#!/usr/bin/env node
/**
 * Agent-surface probe — compares what the LIVE site serves (direct fetch)
 * against what AI agents actually see through Anthropic's fetch
 * infrastructure (web_fetch server tool — same fetcher/cache Claude.ai uses).
 *
 * Born from the 2026-06-12 White Unicorn saga: the server was verified fixed
 * five times while Claude.ai sessions kept reporting stale/misrouted results.
 * The only untestable layer was Anthropic's fetcher — this script tests it.
 *
 * Usage:
 *   node scripts/agent-surface-probe.mjs                       # default intent set
 *   node scripts/agent-surface-probe.mjs "fuzz pedal" "59 r9"  # custom intents
 *   MODEL=claude-haiku-4-5 node scripts/agent-surface-probe.mjs  # cheaper loops
 *   while true; do node scripts/agent-surface-probe.mjs; sleep 300; done
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const SITE = 'https://altitudeguitar.com';
const MODEL = process.env.MODEL || 'claude-opus-4-8';
const intents = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gibson custom shop historic r9 1959 les paul burst', '1959 les paul reissue r9 flame top', 'gibson firebird sunburst'];

const client = new Anthropic(); // ANTHROPIC_API_KEY from .env

async function direct(url) {
  const r = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(45_000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; agent-surface-probe)' },
  });
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) return `${r.status} → ${loc}`;
  const ct = (r.headers.get('content-type') || '').split(';')[0];
  const body = await r.text();
  return `${r.status} ${ct} | ${body.slice(0, 120).replace(/\s+/g, ' ')}`;
}

async function viaAnthropicFetcher(url) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 }],
    messages: [{
      role: 'user',
      content:
        `Fetch exactly this URL: ${url}\n` +
        'Then report, verbatim and with NO interpretation or prior knowledge:\n' +
        '1. The final URL you ended up on (after any redirects)\n' +
        '2. The content type (markdown page, HTML, JSON, error)\n' +
        '3. The first heading or first line of the content\n' +
        'If the fetch fails, report the exact error. Do not retry with different URLs.',
    }],
  });
  if (response.stop_reason === 'refusal') return 'REFUSED by safety classifier';
  const out = [];
  for (const block of response.content) {
    if (block.type === 'web_fetch_tool_result') {
      const c = block.content;
      if (c?.type === 'web_fetch_result') out.push(`[fetched: ${c.url}]`);
      else if (c?.type === 'web_fetch_tool_result_error') out.push(`[fetch error: ${c.error_code}]`);
    }
    if (block.type === 'text') out.push(block.text.trim());
  }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, 400);
}

console.log(`model=${MODEL} | ${new Date().toISOString()}\n`);
for (const intent of intents) {
  const url = `${SITE}/api/intent?intent=${encodeURIComponent(intent)}`;
  console.log(`━━ "${intent}"`);
  const [d, a] = await Promise.all([
    direct(url).catch((e) => `ERROR ${e}`),
    viaAnthropicFetcher(url).catch((e) => `ERROR ${e}`),
  ]);
  console.log(`  direct:    ${d}`);
  console.log(`  anthropic: ${a}`);
  const directGood = !/bonvillain|white-unicorn/i.test(d);
  const anthroGood = !/bonvillain|white.?unicorn/i.test(a);
  console.log(`  verdict:   ${directGood && anthroGood ? '✅ both clean' : directGood ? '⚠️ ANTHROPIC FETCHER DIVERGES (stale cache?)' : '❌ server-side problem'}\n`);
}
