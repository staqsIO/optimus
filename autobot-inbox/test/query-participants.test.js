import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, classifyIntent } from '../../lib/rag/query-participants.js';

describe('query-participants', () => {
  describe('extractCandidates', () => {
    it('pulls bare emails', () => {
      const out = extractCandidates('forward to eric@staqs.io please');
      assert.deepEqual(out.emails, ['eric@staqs.io']);
    });

    it('pulls capitalized names', () => {
      const out = extractCandidates('what did John Smith say about pricing?');
      assert.ok(out.names.includes('John Smith'));
    });

    it('skips common stopwords that happen to be capitalized', () => {
      const out = extractCandidates('What did Optimus decide on Monday?');
      assert.deepEqual(out.names, []); // both words are stopwords
    });

    it('does not double-count name appearing in an email local-part', () => {
      const out = extractCandidates('email from eric@staqs.io');
      assert.ok(out.emails.includes('eric@staqs.io'));
      // The substring "staqs" shouldn't be counted as a name
      assert.ok(!out.names.some(n => n.toLowerCase().includes('staqs')));
    });
  });

  describe('classifyIntent', () => {
    const cases = [
      ['what happened in the meeting with John?', 'filter'],
      ['email from Sarah last week', 'filter'],
      ['what did John say about the budget?', 'filter'],
      ['tell me about John', 'boost'],
      ['what is John working on', 'boost'],
      ['summary of the q3 plan', 'boost'],
    ];
    for (const [q, expected] of cases) {
      it(`"${q}" → ${expected}`, () => {
        assert.equal(classifyIntent(q), expected);
      });
    }
  });
});
