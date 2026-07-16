/**
 * Tool-call integrity tests (PR-1 correctness/observability layer).
 *
 * Covers: safeParseJSON failing loud (marked, not silent {}), repair-once on
 * malformed / non-object / missing-required tool input, FAIL-CLOSED neutralization
 * after a failed retry (the bad call is stripped so it can never reach guardCheck),
 * proper role alternation in the repair re-prompt, streaming parity, and the
 * tool_call_repair_rate counter. Mocked at the SDK-client boundary (a pre-set
 * llm.client bypasses ensureOllamaClient) — same pattern as
 * llm-provider-ollama.test.js. The ollama path is used because it shares the
 * OpenAI-format normalizer with openrouter and needs no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callProvider,
  callProviderStream,
  isToolInputError,
  getToolCallRepairStats,
  resetToolCallRepairStats,
} from '../../lib/llm/provider.js';

// A client whose create() returns queued responses in order (last repeats).
// Records each request body so tests can inspect the repair conversation.
function mockClient(responses) {
  const client = {
    calls: 0,
    bodies: [],
    chat: {
      completions: {
        create: async (body) => {
          client.bodies.push(body);
          const r = responses[Math.min(client.calls, responses.length - 1)];
          client.calls += 1;
          return typeof r === 'function' ? r() : r;
        },
      },
    },
  };
  return client;
}

function orResp(args, { name = 'do_thing', id = 'tc_1' } = {}) {
  return {
    choices: [{
      message: { content: '', tool_calls: [{ id, function: { name, arguments: args } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// A plain text response with NO tool calls (the model gives up on tool-calling).
function orText(text) {
  return {
    choices: [{ message: { content: text, tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// An OpenAI-format streaming chunk sequence for a single tool call.
function streamOf(args, { name = 'do_thing', id = 'tc_1' } = {}) {
  return (async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  })();
}

const TOOLS = [{
  name: 'do_thing',
  description: 't',
  input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
}];

function makeLLM(client) {
  return { provider: 'ollama', modelId: 'llama3.2', modelConfig: {}, client };
}

const baseParams = (extra = {}) => ({
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  ...extra,
});

async function drainStream(gen) {
  let final;
  for await (const frame of gen) if (frame.type === 'final') final = frame.response;
  return final;
}

test('well-formed tool call is a no-op: one round-trip, no repair, no markers', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{"x":1}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 1, 'no repair retry for valid input');
  assert.deepEqual(result.toolCalls[0].input, { x: 1 });
  assert.equal(isToolInputError(result.toolCalls[0].input), false);
  const stats = getToolCallRepairStats();
  assert.equal(stats.repairsTriggered, 0);
  assert.equal(stats.parseFailures, 0);
  assert.equal(stats.tool_call_repair_rate, 0);
});

test('malformed JSON fails loud (parse error) and repairs once with a role-alternating re-prompt', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{bad json'), orResp('{"x":1}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2, 'exactly one repair retry');
  assert.deepEqual(result.toolCalls[0].input, { x: 1 }, 'recovered valid input');

  // The repair re-prompt must not send consecutive user turns: the failed
  // assistant attempt is injected before the corrective user turn.
  const retryMsgs = client.bodies[1].messages;
  const roles = retryMsgs.map((m) => m.role);
  assert.equal(roles[roles.length - 1], 'user', 'ends with the corrective user turn');
  assert.equal(roles[roles.length - 2], 'assistant', 'assistant attempt precedes it — no user,user');
  for (let i = 1; i < roles.length; i++) {
    assert.ok(!(roles[i] === 'user' && roles[i - 1] === 'user'), 'no consecutive user roles');
  }

  const stats = getToolCallRepairStats();
  assert.ok(stats.parseFailures >= 1, 'parse failure counted');
  assert.equal(stats.repairsTriggered, 1);
  assert.equal(stats.repairsSucceeded, 1);
  assert.ok(stats.tool_call_repair_rate > 0);
});

test('a parse failure alone (no required fields) still fails loud and triggers repair', async () => {
  resetToolCallRepairStats();
  const noReqTools = [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }];
  const client = mockClient([orResp('not json at all'), orResp('{}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: noReqTools }));

  assert.equal(client.calls, 2, 'parse failure is repair-eligible even with no required fields');
  assert.deepEqual(result.toolCalls[0].input, {}, 'recovered legitimate empty {}');
  assert.equal(isToolInputError(result.toolCalls[0].input), false);
  assert.ok(getToolCallRepairStats().parseFailures >= 1, 'the failure was counted, not swallowed');
});

test('valid JSON missing a required field triggers repair', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{"y":2}'), orResp('{"x":7}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2);
  assert.deepEqual(result.toolCalls[0].input, { x: 7 });
  assert.equal(getToolCallRepairStats().repairsTriggered, 1);
  assert.equal(getToolCallRepairStats().repairsSucceeded, 1);
});

test('non-object JSON input (null) is malformed for an object schema and triggers repair', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('null'), orResp('{"x":1}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2, 'null bypassed the required-field check before — now repaired');
  assert.deepEqual(result.toolCalls[0].input, { x: 1 });
  assert.equal(getToolCallRepairStats().repairsTriggered, 1);
});

test('non-object JSON input (array) is malformed for an object schema and triggers repair', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('[]'), orResp('{"x":1}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2, 'array input is repair-eligible');
  assert.deepEqual(result.toolCalls[0].input, { x: 1 });
  assert.equal(getToolCallRepairStats().repairsTriggered, 1);
});

test('still-malformed after retry → FAIL CLOSED: bad call stripped, stopReason downgraded', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{bad'), orResp('{also bad')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2, 'exactly one retry — never loops');
  // Marking alone is not enforcement: the corrupt call is REMOVED so it can never
  // reach guardCheck via a consumer that does not check isToolInputError.
  assert.equal(result.toolCalls.length, 0, 'malformed tool call stripped from response');
  assert.equal(result.stopReason, 'tool_validation_failed', 'not a tool_use response — consumers fail closed');
  const stats = getToolCallRepairStats();
  assert.equal(stats.repairsTriggered, 1);
  assert.equal(stats.repairsFailed, 1);
});

test('retry emits ZERO tool calls (model gives up) → marked tool_validation_failed, not a clean answer', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{bad'), orText('I cannot do that.')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2);
  assert.equal(result.toolCalls.length, 0, 'no tool call to execute');
  assert.equal(result.stopReason, 'tool_validation_failed', 'failed repair is not mistaken for a success');
  assert.equal(getToolCallRepairStats().repairsFailed, 1);
});

test('streaming path routes through repair and recovers (parity with blocking)', async () => {
  resetToolCallRepairStats();
  const client = mockClient([streamOf('{bad'), orResp('{"x":1}')]);
  const result = await drainStream(callProviderStream(makeLLM(client), baseParams({ tools: TOOLS })));

  assert.equal(client.calls, 2, 'streaming no longer bypasses repair');
  assert.deepEqual(result.toolCalls[0].input, { x: 1 }, 'streaming malformed input recovered on retry');
  assert.equal(getToolCallRepairStats().repairsSucceeded, 1);
});

test('streaming path FAILS CLOSED when repair cannot recover', async () => {
  resetToolCallRepairStats();
  const client = mockClient([streamOf('{bad'), orResp('{also bad')]);
  const result = await drainStream(callProviderStream(makeLLM(client), baseParams({ tools: TOOLS })));

  assert.equal(result.toolCalls.length, 0, 'streaming corrupt tool call stripped');
  assert.equal(result.stopReason, 'tool_validation_failed', 'streaming consumer fails closed too');
  assert.equal(getToolCallRepairStats().repairsFailed, 1);
});

test('repair folds the failed attempt tokens into returned usage (no spend underreport)', async () => {
  // Each mock round-trip bills 10 in / 5 out. A repair = 2 round-trips, so the
  // returned usage must be 20 in / 10 out — not just the retry's 10/5 — or every
  // repaired call underreports cost to G1/G10 spend caps.
  resetToolCallRepairStats();
  const client = mockClient([orResp('{bad'), orResp('{"x":1}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 2);
  assert.equal(result.inputTokens, 20, 'first attempt + retry input tokens both billed');
  assert.equal(result.outputTokens, 10, 'first attempt + retry output tokens both billed');
});

test('a well-formed call (no repair) reports usage unchanged — accumulation is repair-only', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{"x":1}')]);
  const result = await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  assert.equal(client.calls, 1);
  assert.equal(result.inputTokens, 10, 'single round-trip usage untouched');
  assert.equal(result.outputTokens, 5);
});

test('tool_call_repair_rate is per-call: a 2-malformed-call response reads 2/2, not 1/2', async () => {
  resetToolCallRepairStats();
  // A response with TWO tool calls, both malformed. One repair event, two bad calls.
  const twoBad = {
    choices: [{
      message: {
        content: '',
        tool_calls: [
          { id: 'a', function: { name: 'do_thing', arguments: '{bad' } },
          { id: 'b', function: { name: 'do_thing', arguments: '{also bad' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const twoGood = {
    choices: [{
      message: {
        content: '',
        tool_calls: [
          { id: 'a', function: { name: 'do_thing', arguments: '{"x":1}' } },
          { id: 'b', function: { name: 'do_thing', arguments: '{"x":2}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const client = mockClient([twoBad, twoGood]);
  await callProvider(makeLLM(client), baseParams({ tools: TOOLS }));

  const stats = getToolCallRepairStats();
  assert.equal(stats.toolCallsSeen, 2, 'both calls counted');
  assert.equal(stats.toolCallsMalformed, 2, 'both malformed calls counted (per-call numerator)');
  assert.equal(stats.repairsTriggered, 1, 'one repair EVENT for the response');
  assert.equal(stats.tool_call_repair_rate, 1, '2/2 — unit-consistent, not 1/2');
});

test('no tools passed → repair layer is inert (never inspects tool calls)', async () => {
  resetToolCallRepairStats();
  const client = mockClient([orResp('{bad json')]);
  const result = await callProvider(makeLLM(client), baseParams());

  assert.equal(client.calls, 1);
  assert.equal(getToolCallRepairStats().toolCallsSeen, 0);
  assert.equal(getToolCallRepairStats().repairsTriggered, 0);
  assert.ok(result.toolCalls, 'response shape unchanged');
});
