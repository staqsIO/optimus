import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapePostgresRegex,
  pickResolvedWikiCandidate,
  wikiBacklinkRegexPatterns,
} from '../../lib/wiki/wikilink-resolve.js';
import {
  collectWikiEvidenceEntries,
  extractWikilinks,
  extractWikiSignalFence,
  parseWikiSignalAssessmentMarkdown,
  toSlug,
} from '../../lib/wiki/compiler.js';

describe('wikilink-resolve', () => {
  describe('escapePostgresRegex', () => {
    it('leaves alphanumeric hyphens unchanged', () => {
      assert.equal(escapePostgresRegex('architecture-notes'), 'architecture-notes');
    });

    it('escapes regex metacharacters', () => {
      assert.equal(escapePostgresRegex('a.b'), 'a\\.b');
      assert.equal(escapePostgresRegex('x*y'), 'x\\*y');
      assert.equal(escapePostgresRegex('p+q'), 'p\\+q');
      assert.equal(escapePostgresRegex('(group)'), '\\(group\\)');
    });

    it('escapes brackets and backslashes', () => {
      assert.equal(escapePostgresRegex('a[b]'), 'a\\[b\\]');
      assert.equal(escapePostgresRegex('x\\y'), 'x\\\\y');
    });
  });

  describe('wikiBacklinkRegexPatterns', () => {
    it('builds anchored patterns for plain slugs', () => {
      const { exactClose, pipeOpen } = wikiBacklinkRegexPatterns('overview');
      assert.equal(exactClose, '\\[\\[overview\\]\\]');
      assert.equal(pipeOpen, '\\[\\[overview\\|');
    });

    it('embeds escaped slug for special characters', () => {
      const { exactClose } = wikiBacklinkRegexPatterns('api.v2');
      assert.ok(exactClose.includes('\\.'));
    });
  });

  describe('pickResolvedWikiCandidate', () => {
    it('returns null for empty input', () => {
      assert.equal(pickResolvedWikiCandidate([], 'p1'), null);
      assert.equal(pickResolvedWikiCandidate(null, 'p1'), null);
    });

    it('returns the only candidate', () => {
      const a = { id: '1', project_id: 'p1' };
      assert.equal(pickResolvedWikiCandidate([a], 'p1'), a);
    });

    it('prefers same project as referrer', () => {
      const org = { id: 'o', project_id: null };
      const proj = { id: 'j', project_id: 'p99' };
      assert.equal(pickResolvedWikiCandidate([org, proj], 'p99'), proj);
      assert.equal(pickResolvedWikiCandidate([proj, org], 'p99'), proj);
    });

    it('falls back to org-wide when referrer has no project', () => {
      const org = { id: 'o', project_id: null };
      const proj = { id: 'j', project_id: 'p99' };
      assert.equal(pickResolvedWikiCandidate([org, proj], null), org);
    });

    it('falls back to first when no org and no project match', () => {
      const a = { id: 'a', project_id: 'p1' };
      const b = { id: 'b', project_id: 'p2' };
      assert.equal(pickResolvedWikiCandidate([a, b], 'p9'), a);
    });
  });
});

describe('compiler wikilink helpers', () => {
  it('extractWikilinks dedupes and handles display form', () => {
    const md = 'See [[Foo]] and [[foo|Bar]] and [[Foo]] again.';
    const links = extractWikilinks(md);
    assert.ok(links.includes('Foo'));
    assert.ok(links.includes('foo'));
  });

  it('toSlug matches Board normalization for link targets', () => {
    assert.equal(toSlug('Architecture Notes'), 'architecture-notes');
    assert.equal(toSlug('API v2'), 'api-v2');
  });

  it('extractWikiSignalFence removes the last wiki-signal block', () => {
    const md = '# Hi\n\n```wiki-signal\ntags: news\nconfidence: low\nactionability: watch-only\nrationale: x\n```\n';
    const { remainder, yaml } = extractWikiSignalFence(md);
    assert.ok(!remainder.includes('wiki-signal'));
    assert.match(yaml || '', /tags:\s*news/);
  });

  it('extractWikiSignalFence leaves markdown unchanged when no block', () => {
    const md = '# Only body\n\n[[link]]';
    const { remainder, yaml } = extractWikiSignalFence(md);
    assert.equal(yaml, null);
    assert.equal(remainder.trim(), md.trim());
  });

  it('collectWikiEvidenceEntries prefers item_url then ingested Source URL line', () => {
    const rows = [
      { id: 'a', title: 'A', raw_text: '', metadata: { item_url: 'https://example.com/a' } },
      { id: 'b', title: 'B', raw_text: 'Source URL: https://example.com/b\n', metadata: {} },
    ];
    const ev = collectWikiEvidenceEntries(rows);
    assert.equal(ev[0].url, 'https://example.com/a');
    assert.equal(ev[1].url, 'https://example.com/b');
  });

  it('parseWikiSignalAssessmentMarkdown reads tag chips and fields', () => {
    const md = [
      '# X',
      '',
      '## Signal assessment',
      '',
      '- **Tags:** `news`, `breakthrough`',
      '- **Confidence:** high',
      '- **Actionability:** actionable-upgrade',
      '- **Rationale:** Test rationale here.',
    ].join('\n');
    const s = parseWikiSignalAssessmentMarkdown(md);
    assert.ok(s);
    assert.deepEqual(s.tags, ['news', 'breakthrough']);
    assert.equal(s.confidence, 'high');
    assert.equal(s.actionability, 'actionable-upgrade');
    assert.match(s.rationale || '', /Test rationale/);
  });
});
