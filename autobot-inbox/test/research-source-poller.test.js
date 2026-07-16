import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pollResearchSources,
  pollResearchFeeds,
  canonicalUrlKey,
  itemSourceId,
  resolveFeedBody,
} from '../src/research/research-source-poller.js';

describe('research-source-poller exports', () => {
  it('exports poll entrypoints', () => {
    assert.equal(typeof pollResearchSources, 'function');
    assert.equal(pollResearchFeeds, pollResearchSources);
  });
});

describe('canonicalUrlKey', () => {
  it('collapses protocol, www, trailing slash, query and fragment to one key', () => {
    const variants = [
      'https://karpathy.ai/?utm_source=feed',
      'http://www.karpathy.ai/',
      'https://karpathy.ai',
      'https://karpathy.ai/#about',
      'HTTPS://Karpathy.AI/',
    ];
    const keys = new Set(variants.map(canonicalUrlKey));
    assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(' | ')}`);
    assert.equal([...keys][0], 'karpathy.ai');
  });

  it('preserves path identity for distinct sources', () => {
    assert.notEqual(
      canonicalUrlKey('https://arxiv.org/abs/1406.2661'),
      canonicalUrlKey('https://arxiv.org/abs/1506.02078')
    );
  });

  it('returns empty string for missing/blank urls', () => {
    assert.equal(canonicalUrlKey(''), '');
    assert.equal(canonicalUrlKey(null), '');
    assert.equal(canonicalUrlKey(undefined), '');
  });
});

describe('itemSourceId dedup stability (regression: feed-poller duplicate storm)', () => {
  it('is identical for the same URL even when the LLM rewords title/text/id every poll', () => {
    // Same underlying source, three different web-search responses.
    const poll1 = {
      id: 'openai:aaa',
      title: '**Deep Visual-Semantic Alignments for Generating Image Descriptions**',
      link: 'https://cs.stanford.edu/people/karpathy/deepimagesent/',
      text: 'A paper analyzing...',
    };
    const poll2 = {
      id: 'openai:bbb',
      title: '**"Deep Visual-Semantic Alignments for Generating Image Descriptions"** - A seminal paper by Karpathy',
      link: 'https://cs.stanford.edu/people/karpathy/deepimagesent/?utm=feed',
      text: 'These resources provide in-depth technical insights...',
    };
    const poll3 = {
      id: 'openai:ccc',
      title: 'Deep Visual-Semantic Alignments (Karpathy & Fei-Fei)',
      link: 'http://www.cs.stanford.edu/people/karpathy/deepimagesent',
      text: 'completely different blurb wording',
    };
    const sub = 'a3b125f9-1430-49c2-bc6b-90fb8b04ad75';
    const id1 = itemSourceId(sub, poll1);
    assert.equal(itemSourceId(sub, poll2), id1);
    assert.equal(itemSourceId(sub, poll3), id1);
  });

  it('differs for distinct sources and is namespaced per subscription', () => {
    const a = { link: 'https://arxiv.org/abs/1406.2661' };
    const b = { link: 'https://arxiv.org/abs/1506.02078' };
    assert.notEqual(itemSourceId('sub1', a), itemSourceId('sub1', b));
    assert.notEqual(itemSourceId('sub1', a), itemSourceId('sub2', a));
    assert.match(itemSourceId('sub1', a), /^feed:sub1:[0-9a-f]{24}$/);
  });

  it('falls back to a stable title hash when no url is present', () => {
    const noUrl = { id: 'openai:x', title: 'Untitled note', text: 'body' };
    assert.equal(itemSourceId('sub1', noUrl), itemSourceId('sub1', { title: 'Untitled note' }));
  });
});

describe('resolveFeedBody (STAQPRO-603: ingest real page content, not blurbs)', () => {
  const item = { title: 'Search Title', link: 'https://x.com/a', text: 'one-line search rationale' };

  it('prefers fetched page content + page title when the page is substantial', () => {
    const page = { title: 'Real Page Title', content: 'x'.repeat(500) };
    const r = resolveFeedBody(item, page, null);
    assert.equal(r.sourceKind, 'feed_page');
    assert.equal(r.title, 'Real Page Title');
    assert.equal(r.bodyText.length, 500);
    assert.equal(r.fetchError, null);
  });

  it('falls back to the search summary when the page is too thin (<200 chars)', () => {
    const page = { title: 'Stub', content: 'too short' };
    const r = resolveFeedBody(item, page, null);
    assert.equal(r.sourceKind, 'feed_item');
    assert.equal(r.bodyText, 'one-line search rationale');
    assert.match(r.fetchError, /too little content/);
  });

  it('falls back and preserves the fetch error when the page could not be fetched', () => {
    const r = resolveFeedBody(item, null, 'page fetch failed: 404');
    assert.equal(r.sourceKind, 'feed_item');
    assert.equal(r.bodyText, 'one-line search rationale');
    assert.equal(r.title, 'Search Title');
    assert.equal(r.fetchError, 'page fetch failed: 404');
  });

  it('keeps the item title when the fetched page has no title', () => {
    const page = { content: 'y'.repeat(300) };
    const r = resolveFeedBody(item, page, null);
    assert.equal(r.sourceKind, 'feed_page');
    assert.equal(r.title, 'Search Title');
  });

  it('no page and no error (e.g. no link) → plain summary, no error', () => {
    const r = resolveFeedBody({ title: 'T', text: 'summary' }, null, null);
    assert.equal(r.sourceKind, 'feed_item');
    assert.equal(r.bodyText, 'summary');
    assert.equal(r.fetchError, null);
  });
});
