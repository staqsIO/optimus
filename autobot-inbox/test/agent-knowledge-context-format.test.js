import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-311 Phase 3: formatKnowledgeContext renders the source-typed
 * citation block agents inject into their prompts.
 *
 * Verifies (for both responder + strategist — kept inline-duplicate per
 * Neo Architect's "extract only after the pattern stabilizes" rule, so
 * both must stay in sync):
 *   - Wiki items render as `[wiki:${slug}] ${title}` followed by excerpt
 *   - Document items render as `[doc:${id}]` followed by excerpt
 *   - Mixed source types render in input order with consistent shape
 *   - Empty / undefined / no-items input returns empty string (caller
 *     uses a ternary that suppresses the section entirely)
 *   - Responder + strategist helpers produce IDENTICAL output for the
 *     same input — the duplication invariant
 */

const sampleKnowledge = {
  items: [
    {
      sourceType: 'wiki_pages',
      id: 'voice/profiles',
      title: 'Voice Profiles',
      excerpt: 'Eric writes casually, no em-dashes.',
      classificationLevel: 1,
      score: 0.42,
    },
    {
      sourceType: 'documents',
      id: 'abc-123',
      excerpt: 'Meeting on 2026-04-10 with Nicole about the website rebuild.',
      classificationLevel: 1,
      score: 0.38,
    },
  ],
  totalTokens: 30,
};

describe('formatKnowledgeContext (STAQPRO-311 Phase 3)', () => {
  it('responder helper renders wiki + doc citations correctly', async () => {
    const { formatKnowledgeContext } = await import('../../agents/executor-responder/index.js');

    const out = formatKnowledgeContext(sampleKnowledge);

    assert.ok(out.startsWith('RELEVANT KNOWLEDGE'), 'starts with the section header');
    assert.match(out, /\[wiki:voice\/profiles\] Voice Profiles/, 'wiki citation present');
    assert.match(out, /Eric writes casually, no em-dashes\./, 'wiki excerpt present');
    assert.match(out, /\[doc:abc-123\]/, 'doc citation present');
    assert.match(out, /Meeting on 2026-04-10/, 'doc excerpt present');
  });

  it('strategist helper renders wiki + doc citations correctly', async () => {
    const { formatKnowledgeContext } = await import('../../agents/strategist/index.js');

    const out = formatKnowledgeContext(sampleKnowledge);

    assert.match(out, /\[wiki:voice\/profiles\] Voice Profiles/);
    assert.match(out, /\[doc:abc-123\]/);
  });

  it('responder + strategist produce identical output for the same input', async () => {
    const responderMod = await import('../../agents/executor-responder/index.js');
    const strategistMod = await import('../../agents/strategist/index.js');

    const a = responderMod.formatKnowledgeContext(sampleKnowledge);
    const b = strategistMod.formatKnowledgeContext(sampleKnowledge);

    assert.equal(a, b, 'inline-duplicate helpers must produce identical output — if they diverge, extract to lib');
  });

  it('empty / undefined / no-items input returns empty string', async () => {
    const { formatKnowledgeContext } = await import('../../agents/executor-responder/index.js');

    assert.equal(formatKnowledgeContext(null), '');
    assert.equal(formatKnowledgeContext(undefined), '');
    assert.equal(formatKnowledgeContext({}), '');
    assert.equal(formatKnowledgeContext({ items: [] }), '');
    assert.equal(formatKnowledgeContext({ items: [], totalTokens: 0 }), '');
  });

  it('wiki item without title still renders the [wiki:slug] tag', async () => {
    const { formatKnowledgeContext } = await import('../../agents/executor-responder/index.js');

    const out = formatKnowledgeContext({
      items: [{ sourceType: 'wiki_pages', id: 'orphan-slug', excerpt: 'body text' }],
      totalTokens: 5,
    });

    assert.match(out, /\[wiki:orphan-slug\]/);
    assert.match(out, /body text/);
  });

  it('item with empty excerpt still surfaces the citation', async () => {
    const { formatKnowledgeContext } = await import('../../agents/executor-responder/index.js');

    const out = formatKnowledgeContext({
      items: [{ sourceType: 'wiki_pages', id: 'no-excerpt', title: 'Empty', excerpt: '' }],
      totalTokens: 0,
    });

    assert.match(out, /\[wiki:no-excerpt\] Empty/, 'header present even with no excerpt');
  });
});
