import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWithSpeakers } from '../../lib/transcription/assemblyai.js';

const utt2 = [
  { speaker: 'A', text: 'hi', start: 0, end: 1000 },
  { speaker: 'A', text: 'how are you', start: 1000, end: 2500 },
  { speaker: 'B', text: 'good', start: 2500, end: 3500 },
];

const utt3 = [
  { speaker: 'A', text: 'one' },
  { speaker: 'A', text: 'two' },
  { speaker: 'B', text: 'three' },
  { speaker: 'C', text: 'four' },
];

test('no overrides — every label gets a "Speaker X" fallback (no primarySpeaker fallback)', () => {
  const r = formatWithSpeakers(utt2, null);
  assert.equal(r.speakers.A, 'Speaker A');
  assert.equal(r.speakers.B, 'Speaker B');
});

test('legacy primarySpeaker arg is ignored — never attributes a real name without a voiceprint match', () => {
  const r = formatWithSpeakers(utt2, 'Mike');
  assert.equal(r.speakers.A, 'Speaker A');
  assert.equal(r.speakers.B, 'Speaker B');
});

test('voiceprint override on the dominant label wins; quieter labels stay Speaker A/B/C', () => {
  const r = formatWithSpeakers(utt2, null, { A: 'Eric Gang' });
  assert.equal(r.speakers.A, 'Eric Gang');
  assert.equal(r.speakers.B, 'Speaker B');
});

test('voiceprint override on a quieter label leaves the dominant label as Speaker A (no uploader-hint mislabel)', () => {
  const r = formatWithSpeakers(utt2, 'Mike', { B: 'Eric Gang' });
  assert.equal(r.speakers.A, 'Speaker A');
  assert.equal(r.speakers.B, 'Eric Gang');
});

test('labelOverrides accept either string or { displayName } values', () => {
  const r = formatWithSpeakers(utt2, null, { A: { displayName: 'Eric Gang', score: 0.81 } });
  assert.equal(r.speakers.A, 'Eric Gang');
});

test('three speakers — fallback letters track count-sorted index, not insertion order', () => {
  const r = formatWithSpeakers(utt3, null, { C: 'Dustin' });
  assert.equal(r.speakers.A, 'Speaker A');    // count-rank 0, no override
  assert.equal(r.speakers.B, 'Speaker B');    // count-rank 1, no override
  assert.equal(r.speakers.C, 'Dustin');       // override wins
});

test('all labels overridden — every speaker gets the matched name', () => {
  const r = formatWithSpeakers(utt3, null, { A: 'Eric', B: 'Dustin', C: 'Jamie' });
  assert.deepEqual(r.speakers, { A: 'Eric', B: 'Dustin', C: 'Jamie' });
});

test('empty utterances — empty result, no crash', () => {
  assert.deepEqual(formatWithSpeakers([], null), { text: '', speakers: {} });
  assert.deepEqual(formatWithSpeakers(null, null), { text: '', speakers: {} });
});

test('Map-typed labelOverrides also accepted', () => {
  const r = formatWithSpeakers(utt2, null, new Map([['A', 'Eric'], ['B', 'Dustin']]));
  assert.deepEqual(r.speakers, { A: 'Eric', B: 'Dustin' });
});
