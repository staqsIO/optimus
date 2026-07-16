import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPlatform,
  classifyVisitorKind,
  classifyVisitor,
} from '../../agents/executor-redesign/visitor-classifier.js';
import {
  serveByMatchEnabled,
  resolveServeByMatch,
  findCorpusMatch,
} from '../src/api-routes/front-door-corpus.js';

// Feature 008 — Progressive Intent Front Door, Phase 1 foundation.
// Pure unit tests: no DB, no network.

describe('classifyPlatform (referrer -> platform)', () => {
  const cases = [
    ['https://chatgpt.com/c/abc123', 'chatgpt'],
    ['https://www.chatgpt.com/', 'chatgpt'],
    ['https://chat.openai.com/share/xyz', 'chatgpt'],
    ['https://openai.com/index', 'chatgpt'],
    ['https://www.perplexity.ai/search?q=x', 'perplexity'],
    ['https://claude.ai/chat/1', 'claude'],
    ['https://www.anthropic.com/', 'claude'],
    ['https://www.google.com/search?q=shoes', 'direct'],
    ['https://t.co/abc', 'direct'],
    ['', 'direct'],
    ['not a url', 'direct'],
    [null, 'direct'],
    [undefined, 'direct'],
  ];
  for (const [referer, expected] of cases) {
    it(`${JSON.stringify(referer)} -> ${expected}`, () => {
      assert.equal(classifyPlatform(referer), expected);
    });
  }
});

describe('classifyVisitorKind (User-Agent -> human|agent)', () => {
  const humanUAs = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  ];
  for (const ua of humanUAs) {
    it(`human browser UA -> human (${ua.slice(0, 24)}...)`, () => {
      assert.equal(classifyVisitorKind(ua), 'human');
    });
  }

  const agentUAs = [
    'GPTBot/1.0 (+https://openai.com/gptbot)',
    'OAI-SearchBot/1.0',
    'ChatGPT-User/1.0',
    'PerplexityBot/1.0',
    'ClaudeBot/1.0',
    'python-requests/2.31.0',
    'axios/1.6.0',
    'node-fetch/1.0',
    'curl/8.4.0',
    'Mozilla/5.0 (compatible; SomeCrawler/2.0; +http://example.com/bot)',
    'My-Custom-Agent/1.0',
  ];
  for (const ua of agentUAs) {
    it(`agent/bot UA -> agent (${ua.slice(0, 24)}...)`, () => {
      assert.equal(classifyVisitorKind(ua), 'agent');
    });
  }

  it('missing UA -> agent (browsers always send one)', () => {
    assert.equal(classifyVisitorKind(''), 'agent');
    assert.equal(classifyVisitorKind(null), 'agent');
    assert.equal(classifyVisitorKind(undefined), 'agent');
  });
});

describe('classifyVisitor (headers -> {visitor_kind, platform, tier})', () => {
  const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  it('tier 1: LLM-referred human (chatgpt)', () => {
    const r = classifyVisitor({ referer: 'https://chatgpt.com/c/1', 'user-agent': HUMAN_UA });
    assert.deepEqual(r, { visitor_kind: 'human', platform: 'chatgpt', tier: 1 });
  });

  it('tier 1: LLM-referred human (perplexity)', () => {
    const r = classifyVisitor({ referer: 'https://www.perplexity.ai/search', 'user-agent': HUMAN_UA });
    assert.deepEqual(r, { visitor_kind: 'human', platform: 'perplexity', tier: 1 });
  });

  it('tier 0: anonymous/direct human (no LLM referrer)', () => {
    const r = classifyVisitor({ referer: 'https://www.google.com/', 'user-agent': HUMAN_UA });
    assert.deepEqual(r, { visitor_kind: 'human', platform: 'direct', tier: 0 });
  });

  it('tier 0: human, no referrer at all', () => {
    const r = classifyVisitor({ 'user-agent': HUMAN_UA });
    assert.deepEqual(r, { visitor_kind: 'human', platform: 'direct', tier: 0 });
  });

  it('agent UA -> visitor_kind agent, platform agent, tier 0 (even with LLM referrer)', () => {
    const r = classifyVisitor({ referer: 'https://chatgpt.com/c/1', 'user-agent': 'GPTBot/1.0' });
    assert.deepEqual(r, { visitor_kind: 'agent', platform: 'agent', tier: 0 });
  });

  it('tolerates the `referrer` misspelling', () => {
    const r = classifyVisitor({ referrer: 'https://claude.ai/chat/1', 'user-agent': HUMAN_UA });
    assert.deepEqual(r, { visitor_kind: 'human', platform: 'claude', tier: 1 });
  });

  it('empty headers -> agent/agent/0 (no UA = automated)', () => {
    const r = classifyVisitor({});
    assert.deepEqual(r, { visitor_kind: 'agent', platform: 'agent', tier: 0 });
  });

  it('defaults headers to {} when omitted', () => {
    const r = classifyVisitor();
    assert.deepEqual(r, { visitor_kind: 'agent', platform: 'agent', tier: 0 });
  });
});

describe('serve-by-match corpus seam (flag-gated skeleton)', () => {
  const ENV_KEY = 'FRONT_DOOR_SERVE_BY_MATCH';
  const HUMAN_UA = 'Mozilla/5.0 Chrome/124.0';
  const sampleArgs = {
    url: 'https://example.com',
    intent: 'waterproof running shoes',
    classification: classifyVisitor({ referer: 'https://chatgpt.com/c/1', 'user-agent': HUMAN_UA }),
  };

  function withFlag(value, fn) {
    const prev = process.env[ENV_KEY];
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    try { return fn(); }
    finally {
      if (prev === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prev;
    }
  }

  it('serveByMatchEnabled is OFF by default (flag unset)', () => {
    withFlag(undefined, () => assert.equal(serveByMatchEnabled(), false));
  });

  it('serveByMatchEnabled honors truthy flag values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', 'On']) {
      withFlag(v, () => assert.equal(serveByMatchEnabled(), true, `value ${v} should enable`));
    }
    for (const v of ['0', 'false', 'off', '', 'no']) {
      withFlag(v, () => assert.equal(serveByMatchEnabled(), false, `value ${v} should disable`));
    }
  });

  it('flag OFF -> resolveServeByMatch falls through (serve:false, flag-off) without a lookup', async () => {
    await withFlag(undefined, async () => {
      const r = await resolveServeByMatch(sampleArgs);
      assert.deepEqual(r, { serve: false, reason: 'flag-off' });
    });
  });

  // Lookup behavior is pinned in depth in test/front-door-corpus.test.js;
  // here we only pin the seam contract /submit relies on: an empty corpus is a
  // clean fall-through, never a throw.
  const emptyCorpusDeps = { _query: async () => ({ rows: [] }), _embedOne: async () => null };

  it('flag ON + empty corpus -> falls through (serve:false, corpus-empty)', async () => {
    await withFlag('true', async () => {
      const r = await resolveServeByMatch(sampleArgs, emptyCorpusDeps);
      assert.equal(r.serve, false);
      assert.equal(r.reason, 'corpus-empty');
    });
  });

  it('findCorpusMatch misses cleanly on an empty corpus', async () => {
    const r = await findCorpusMatch(sampleArgs, emptyCorpusDeps);
    assert.equal(r.hit, false);
    assert.equal(r.reason, 'corpus-empty');
  });
});
