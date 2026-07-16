import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripReasoningTags,
  createThinkStripper,
} from '../../lib/llm/provider.js';

// ---------------------------------------------------------------------------
// stripReasoningTags — the blocking-path / final-text strip.
// ---------------------------------------------------------------------------

test('stripReasoningTags: no <think> → byte-identical passthrough', () => {
  const s = 'The answer is 42.';
  assert.equal(stripReasoningTags(s), s);
});

test('stripReasoningTags: removes a closed think block', () => {
  assert.equal(
    stripReasoningTags('<think>ponder ponder</think>Final answer.'),
    'Final answer.'
  );
});

test('stripReasoningTags: removes an UNCLOSED trailing think block (truncation)', () => {
  assert.equal(
    stripReasoningTags('Visible.<think>cut off mid-thought'),
    'Visible.'
  );
});

test('stripReasoningTags: leaves tool-call-free non-string input alone', () => {
  assert.equal(stripReasoningTags(null), null);
  assert.equal(stripReasoningTags(undefined), undefined);
});

// ---------------------------------------------------------------------------
// createThinkStripper — the streaming filter. The defect class Codex caught was
// a <think>/<\/think> tag split across token-boundaries leaking the scratchpad.
// ---------------------------------------------------------------------------

// Drive the stripper with an arbitrary chunking of the full text and assert the
// concatenated emitted output equals `expected`.
function runStripper(chunks) {
  const s = createThinkStripper();
  let out = '';
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  return out;
}

test('stripper: passthrough when no think block', () => {
  assert.equal(runStripper(['Hello ', 'world', '!']), 'Hello world!');
});

test('stripper: strips a think block delivered as one chunk', () => {
  assert.equal(runStripper(['<think>secret</think>answer']), 'answer');
});

test('stripper: strips think block with OPENING tag split across chunks', () => {
  // '<thi' + 'nk>...' — the opening tag straddles the boundary.
  assert.equal(runStripper(['pre <thi', 'nk>hidden</think> post']), 'pre  post');
});

test('stripper: strips think block with CLOSING tag split across chunks', () => {
  assert.equal(runStripper(['a<think>hidden</thi', 'nk>b']), 'ab');
});

test('stripper: every single-character chunking still strips (fuzz the boundary)', () => {
  const full = 'before<think>SCRATCH PAD lots of tokens</think>after';
  const chunks = full.split(''); // worst case: 1 char per delta
  assert.equal(runStripper(chunks), 'beforeafter');
});

test('stripper: unclosed think block at stream end is dropped, not leaked', () => {
  assert.equal(runStripper(['visible<think>never clo', 'sed and cut']), 'visible');
});

test('stripper: a literal "<" that is NOT a think tag is eventually emitted', () => {
  // Held back briefly as a possible '<think>' prefix, then released once
  // disambiguated by following text.
  assert.equal(runStripper(['x < ', 'y']), 'x < y');
});

test('stripper: multiple think blocks in one stream', () => {
  assert.equal(
    runStripper(['a<think>1</think>b<think>2</think>c']),
    'abc'
  );
});

test('stripper: never emits the literal substring "<think>"', () => {
  const full = 'lead<think>hidden reasoning</think>tail';
  for (let cut = 1; cut < full.length; cut++) {
    const out = runStripper([full.slice(0, cut), full.slice(cut)]);
    assert.ok(!out.includes('<think>'), `leaked open tag at cut=${cut}: ${out}`);
    assert.ok(!out.includes('</think>'), `leaked close tag at cut=${cut}: ${out}`);
    assert.ok(!out.includes('hidden'), `leaked scratchpad at cut=${cut}: ${out}`);
  }
});
