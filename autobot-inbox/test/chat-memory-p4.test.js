/**
 * P4 chat memory: partition-key validation (Linus M3) and extraction-output
 * parsing. The key rule: memory buckets are built ONLY from well-formed
 * GitHub usernames — anything else gets NO bucket, never a shared one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatMemoryKey, parseExtractedMemories } from '../src/commands/agent-chat.js';

test('chatMemoryKey accepts only well-formed GitHub usernames', () => {
  assert.equal(chatMemoryKey('ecgang'), 'chat:ecgang');
  assert.equal(chatMemoryKey('Dustin-B-1'), 'chat:Dustin-B-1');
  // rejected: anything that isn't a 1-39 char alphanumeric/hyphen handle
  for (const bad of ['', 'Eric Gang', 'unknown!', 'a'.repeat(40), 'éric', 'chat:ecgang', undefined, null, 42]) {
    assert.equal(chatMemoryKey(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // "unknown" is a valid shape — acceptable: it maps to its own bucket, not
  // another member's. The real protection is the proxy's 401 gate upstream.
  assert.equal(chatMemoryKey('unknown'), 'chat:unknown');
});

test('parseExtractedMemories: clean array, fenced, and prose-wrapped JSON', () => {
  const arr = [{ type: 'preference', content: 'Keep answers short and direct' }];
  // 010-C: each memory now carries an entities array (empty when none extracted).
  const expected = [{ type: 'preference', content: 'Keep answers short and direct', entities: [] }];
  assert.deepEqual(parseExtractedMemories(JSON.stringify(arr)), expected);
  assert.deepEqual(parseExtractedMemories('```json\n' + JSON.stringify(arr) + '\n```'), expected);
  assert.deepEqual(parseExtractedMemories('Here you go: ' + JSON.stringify(arr) + ' hope that helps'), expected);
});

test('parseExtractedMemories: strict shape filtering', () => {
  // wrong types dropped (extraction may only produce preference/context)
  assert.deepEqual(parseExtractedMemories(JSON.stringify([
    { type: 'failure', content: 'should be dropped here' },
    { type: 'pattern', content: 'should be dropped here' },
    { type: 'context', content: 'Staqs runs on Railway and Supabase' },
  ])), [{ type: 'context', content: 'Staqs runs on Railway and Supabase', entities: [] }]);
  // short content dropped, cap at 3
  const many = Array.from({ length: 6 }, (_, i) => ({ type: 'preference', content: `long enough content number ${i}` }));
  assert.equal(parseExtractedMemories(JSON.stringify(many)).length, 3);
  assert.deepEqual(parseExtractedMemories(JSON.stringify([{ type: 'preference', content: 'short' }])), []);
  // garbage in → empty out
  assert.deepEqual(parseExtractedMemories('no json here'), []);
  assert.deepEqual(parseExtractedMemories('[not valid json'), []);
  assert.deepEqual(parseExtractedMemories(JSON.stringify({ type: 'preference', content: 'an object, not array' })), []);
  assert.deepEqual(parseExtractedMemories('[]'), []);
});

test('recordChatFeedback rejects invalid feedback values before touching the DB', async () => {
  const { recordChatFeedback } = await import('../src/commands/agent-chat.js');
  for (const bad of [5, 0, 'up', 2, -2]) {
    await assert.rejects(
      recordChatFeedback({ sessionId: 's', messageId: 'm', boardUser: 'ecgang', feedback: bad }),
      (err) => err.statusCode === 400,
      `expected 400 for feedback=${JSON.stringify(bad)}`
    );
  }
});
