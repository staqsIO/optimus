import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agents = JSON.parse(
  readFileSync(join(__dirname, '../config/agents.json'), 'utf8')
);

// Reasoning models (chain-of-thought / <think> scratchpad, e.g. DeepSeek-R1)
// are NOT reliable tool callers. Liotta + Linus binding constraint: a reasoning
// model must NEVER be assigned to an agent that makes tool calls. This test is
// the infrastructure enforcement (P2) of that invariant — it fails the build if
// any tool-bearing agent is pointed at a reasoning SKU.
const REASONING_MODEL_RE = /(-r1\b|\breasoner\b|:thinking\b)/i;

function toolCount(agent) {
  const tools = Array.isArray(agent.tools) ? agent.tools.length : 0;
  const chatTools = Array.isArray(agent.chat?.chatTools)
    ? agent.chat.chatTools.length
    : 0;
  return tools + chatTools;
}

test('no tool-bearing agent is assigned a reasoning model', () => {
  const violations = [];
  for (const [id, agent] of Object.entries(agents.agents || {})) {
    if (agent.enabled === false) continue;
    if (typeof agent.model !== 'string') continue;
    if (!REASONING_MODEL_RE.test(agent.model)) continue;
    if (toolCount(agent) > 0) {
      violations.push(`${id} → ${agent.model} (${toolCount(agent)} tool paths)`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Reasoning model on a tool-calling path (forbidden):\n  ${violations.join('\n  ')}`
  );
});

test('every registered reasoning SKU has G1/G10 cost fields (no unmetered SKU)', () => {
  const missing = [];
  for (const [slug, cfg] of Object.entries(agents.models || {})) {
    if (!REASONING_MODEL_RE.test(slug)) continue;
    if (!(cfg.inputCostPer1M > 0) || !(cfg.outputCostPer1M > 0)) {
      missing.push(slug);
    }
  }
  assert.deepEqual(missing, [], `Reasoning SKU missing cost fields: ${missing.join(', ')}`);
});
