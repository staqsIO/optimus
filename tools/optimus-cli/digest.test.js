import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionDigest, DIGEST_CAP_BYTES } from './digest.js';

const line = (obj) => JSON.stringify(obj);

test('extracts user + assistant text turns', () => {
  const jsonl = [
    line({ type: 'user', message: { role: 'user', content: 'Build the OPT-95 CLI' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
  ].join('\n');

  const digest = buildSessionDigest(jsonl);
  assert.match(digest, /## User\s+Build the OPT-95 CLI/);
  assert.match(digest, /## Assistant\s+On it\./);
});

test('drops tool_use / tool_result noise, keeps surrounding text', () => {
  const jsonl = [
    line({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/secret' } },
    ] } }),
    line({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: 'HUGE TOOL OUTPUT THAT SHOULD NOT APPEAR' },
    ] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
  ].join('\n');

  const digest = buildSessionDigest(jsonl);
  assert.match(digest, /Reading the file\./);
  assert.match(digest, /Done\./);
  assert.doesNotMatch(digest, /HUGE TOOL OUTPUT/);
  assert.doesNotMatch(digest, /\/secret/); // tool_use input must not leak
  // The tool_result-only user turn produced no text -> no empty User section.
  assert.equal((digest.match(/## User/g) || []).length, 0);
});

test('strips system-reminder blocks from user turns', () => {
  const jsonl = line({
    type: 'user',
    message: { role: 'user', content: 'Real prompt.<system-reminder>noise here</system-reminder>' },
  });
  const digest = buildSessionDigest(jsonl);
  assert.match(digest, /Real prompt\./);
  assert.doesNotMatch(digest, /noise here/);
});

test('caps at the byte limit with a truncation marker', () => {
  const big = 'x'.repeat(2 * 1024 * 1024); // 2 MB of text, well over the cap
  const jsonl = line({ type: 'assistant', message: { role: 'assistant', content: big } });

  const digest = buildSessionDigest(jsonl);
  const bytes = new TextEncoder().encode(digest).length;
  assert.ok(bytes <= DIGEST_CAP_BYTES, `digest ${bytes} bytes should be <= ${DIGEST_CAP_BYTES}`);
  assert.match(digest, /…\[truncated\]$/);
});

test('respects a custom capBytes override', () => {
  const jsonl = line({ type: 'user', message: { role: 'user', content: 'a'.repeat(5000) } });
  const digest = buildSessionDigest(jsonl, { capBytes: 100 });
  assert.ok(new TextEncoder().encode(digest).length <= 100);
  assert.match(digest, /…\[truncated\]$/);
});

test('handles empty input gracefully', () => {
  assert.equal(buildSessionDigest(''), '');
  assert.equal(buildSessionDigest('   \n  '), '');
  assert.equal(buildSessionDigest(null), '');
  assert.equal(buildSessionDigest(undefined), '');
});

test('handles malformed JSONL lines without throwing', () => {
  const jsonl = [
    '{ this is not json',
    line({ type: 'user', message: { role: 'user', content: 'survivor' } }),
    'also garbage }}}',
    '',
  ].join('\n');
  const digest = buildSessionDigest(jsonl);
  assert.match(digest, /survivor/);
});

test('supports the top-level role/content shape (no message wrapper)', () => {
  const jsonl = [
    line({ role: 'user', content: 'top-level user' }),
    line({ role: 'assistant', content: [{ type: 'text', text: 'top-level assistant' }] }),
  ].join('\n');
  const digest = buildSessionDigest(jsonl);
  assert.match(digest, /top-level user/);
  assert.match(digest, /top-level assistant/);
});

test('ignores non-conversational event types', () => {
  const jsonl = [
    line({ type: 'summary', summary: 'meta' }),
    line({ type: 'system', content: 'system stuff' }),
    line({ type: 'user', message: { role: 'user', content: 'kept' } }),
  ].join('\n');
  const digest = buildSessionDigest(jsonl);
  assert.match(digest, /kept/);
  assert.doesNotMatch(digest, /system stuff/);
});
