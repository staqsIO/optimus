/**
 * callProviderStream normalization tests (chat overhaul P1).
 *
 * Providers are mocked at the SDK-client boundary: anthropic via
 * llm.client.messages.create, openrouter via a pre-set llm.client (which
 * makes ensureOpenRouterClient a no-op, so no API key is needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProviderStream } from '../../lib/llm/provider.js';

async function collect(gen) {
  const tokens = [];
  let final = null;
  for await (const ev of gen) {
    if (ev.type === 'token') tokens.push(ev.delta);
    else if (ev.type === 'final') final = ev.response;
  }
  return { tokens, final };
}

function asyncIterableOf(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

test('anthropic stream normalizes tokens, usage, and tool_use blocks', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 120 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'check_pipeline' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"sco' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'pe":"all"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ];
  const llm = {
    provider: 'anthropic',
    modelId: 'claude-test',
    client: { messages: { create: async () => asyncIterableOf(events) } },
  };

  const { tokens, final } = await collect(callProviderStream(llm, {
    system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100,
  }));

  assert.deepEqual(tokens, ['Hello ', 'world']);
  assert.equal(final.text, 'Hello world');
  assert.equal(final.inputTokens, 120);
  assert.equal(final.outputTokens, 42);
  assert.equal(final.stopReason, 'tool_use');
  assert.equal(final.toolCalls.length, 1);
  assert.deepEqual(final.toolCalls[0], { type: 'tool_use', id: 'tu_1', name: 'check_pipeline', input: { scope: 'all' } });
  // raw.content must be Anthropic-format blocks the tool loop can push back
  assert.deepEqual(final.raw.content, [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'tu_1', name: 'check_pipeline', input: { scope: 'all' } },
  ]);
});

test('openrouter stream normalizes deltas, accumulated tool args, and final-chunk usage', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'Hi' } }] },
    { choices: [{ delta: { content: ' there' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_knowledge_base', arguments: '{"que' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } },
  ];
  let capturedBody = null;
  const llm = {
    provider: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
    client: { chat: { completions: { create: async (body) => { capturedBody = body; return asyncIterableOf(chunks); } } } },
  };

  const { tokens, final } = await collect(callProviderStream(llm, {
    system: 'sys',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'prev_1', name: 'check_pipeline', input: { a: 1 } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'prev_1', content: 'ok' },
      ] },
    ],
    maxTokens: 100,
    tools: [{ name: 'search_knowledge_base', description: 'd', input_schema: { type: 'object' } }],
    reasoningEffort: 'low',
  }));

  assert.deepEqual(tokens, ['Hi', ' there']);
  assert.equal(final.text, 'Hi there');
  assert.equal(final.inputTokens, 50);
  assert.equal(final.outputTokens, 9);
  assert.equal(final.stopReason, 'tool_use');
  assert.deepEqual(final.toolCalls[0], { type: 'tool_use', id: 'call_1', name: 'search_knowledge_base', input: { query: 'x' } });

  // Request body: streaming flags + reasoning cap + Anthropic→OpenAI conversion
  assert.equal(capturedBody.stream, true);
  assert.deepEqual(capturedBody.stream_options, { include_usage: true });
  assert.deepEqual(capturedBody.reasoning, { effort: 'low' });
  const msgs = capturedBody.messages;
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  // assistant turn with tool_use → tool_calls
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].content, 'checking');
  assert.deepEqual(msgs[2].tool_calls, [
    { id: 'prev_1', type: 'function', function: { name: 'check_pipeline', arguments: '{"a":1}' } },
  ]);
  // tool_result → role:"tool" message
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'prev_1', content: 'ok' });
});
