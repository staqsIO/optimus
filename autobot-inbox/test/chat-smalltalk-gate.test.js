/**
 * P3 conditional-RAG gate: SMALL_TALK_RE may ONLY match unambiguous courtesy
 * turns. The Phase-0 lesson is load-bearing — short content queries ("Ladd
 * status") and pronoun follow-ups ("what did he say?") MUST keep hitting the
 * KB. The skip condition in handleAgentChat is `SMALL_TALK_RE.test(msg) &&
 * !msg.includes('?')`; this test exercises the same predicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMALL_TALK_RE } from '../src/commands/agent-chat.js';

const skips = (msg) => SMALL_TALK_RE.test(msg.trim()) && !msg.includes('?');

test('courtesy turns skip RAG', () => {
  for (const msg of ['hi', 'Hey!', 'thanks', 'Thank you.', 'ok', 'cool', 'got it', 'sounds good', 'never mind', 'yep', 'Good morning']) {
    assert.equal(skips(msg), true, `expected skip: "${msg}"`);
  }
});

test('content-bearing and ambiguous turns NEVER skip RAG (Phase-0 lesson)', () => {
  for (const msg of [
    'Ladd status',                  // short content query
    'what did he say?',             // pronoun follow-up
    'ok what happened next',        // courtesy prefix + content
    'thanks, and what about Kevin', // courtesy + question without ?
    'yes?',                         // question mark always retrieves
    'status',
    'pipeline',
    'no updates on coastal',
  ]) {
    assert.equal(skips(msg), false, `expected retrieve: "${msg}"`);
  }
});
