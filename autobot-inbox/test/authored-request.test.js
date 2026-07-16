import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAuthoredRequest,
  buildContract,
  isCompleteContract,
  MIN_CRITERIA,
  MAX_CRITERIA,
} from '../../lib/runtime/governance/authored-request.js';

// A well-formed human request used as the baseline for "accept" cases.
const GOOD = {
  title: 'Add CSV export to the contacts list',
  outcome: 'A non-technical user can download the contacts list as a CSV from the board.',
  acceptanceCriteria: [
    'A "Download CSV" button appears on the /contacts page',
    'Clicking it downloads a .csv file containing all visible contacts',
    'The CSV has a header row with column names matching the table',
  ],
  outOfScope: ['Exporting to Excel/xlsx format'],
  pattern: 'new',
};

describe('validateAuthoredRequest', () => {
  it('accepts a complete request and normalizes it', () => {
    const r = validateAuthoredRequest(GOOD);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.equal(r.normalized.title, GOOD.title);
    assert.equal(r.normalized.criteria.length, 3);
    assert.equal(r.normalized.outOfScope.length, 1);
    assert.equal(r.normalized.pattern, 'new');
  });

  it('rejects an empty / "I want a thing" request (P1 deny-by-default)', () => {
    const r = validateAuthoredRequest({});
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 3); // title, outcome, criteria, out-of-scope
  });

  it('rejects a missing/too-short outcome', () => {
    const r = validateAuthoredRequest({ ...GOOD, outcome: 'do it' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('outcome')));
  });

  it(`rejects fewer than ${MIN_CRITERIA} acceptance criteria`, () => {
    const r = validateAuthoredRequest({
      ...GOOD,
      acceptanceCriteria: ['Only one concrete criterion here please'],
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('at least')));
  });

  it(`rejects more than ${MAX_CRITERIA} acceptance criteria`, () => {
    const many = Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => `Concrete checkable criterion number ${i}`);
    const r = validateAuthoredRequest({ ...GOOD, acceptanceCriteria: many });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('at most')));
  });

  it('rejects a vague, non-checkable criterion', () => {
    const r = validateAuthoredRequest({
      ...GOOD,
      acceptanceCriteria: [
        'A "Download CSV" button appears on the /contacts page',
        'make it nice',
        'The CSV has a header row with column names',
      ],
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('not checkable')));
  });

  it('rejects an over-long outcome (availability guard)', () => {
    const r = validateAuthoredRequest({ ...GOOD, outcome: 'x'.repeat(5000) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('too long')));
  });

  it('rejects an over-long criterion', () => {
    const r = validateAuthoredRequest({
      ...GOOD,
      acceptanceCriteria: [GOOD.acceptanceCriteria[0], GOOD.acceptanceCriteria[1], 'y'.repeat(1000)],
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('too long')));
  });

  it('rejects a request with no explicit out-of-scope item', () => {
    const r = validateAuthoredRequest({ ...GOOD, outOfScope: [] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('out-of-scope')));
  });

  it('tolerates non-array / non-string inputs without throwing', () => {
    const r = validateAuthoredRequest({
      title: 5,
      outcome: null,
      acceptanceCriteria: 'not-an-array',
      outOfScope: { nope: true },
    });
    assert.equal(r.ok, false);
  });
});

describe('buildContract', () => {
  it('stores the author words as the contract with null results', () => {
    const { normalized } = validateAuthoredRequest(GOOD);
    const c = buildContract(normalized, 'eric@staqs.io', '2026-06-14T00:00:00.000Z');
    assert.equal(c.outcome, GOOD.outcome);
    assert.equal(c.criteria.length, 3);
    assert.deepEqual(c.criteria[0], { text: GOOD.acceptanceCriteria[0], result: null });
    assert.equal(c.out_of_scope.length, 1);
    assert.equal(c.authored_by, 'eric@staqs.io');
    assert.equal(c.authored_at, '2026-06-14T00:00:00.000Z');
  });
});

describe('isCompleteContract (approve-boundary defense-in-depth)', () => {
  it('accepts a contract built from a valid request', () => {
    const { normalized } = validateAuthoredRequest(GOOD);
    assert.equal(isCompleteContract(buildContract(normalized, 'eric@staqs.io')), true);
  });

  it('rejects null / non-object', () => {
    assert.equal(isCompleteContract(null), false);
    assert.equal(isCompleteContract('nope'), false);
    assert.equal(isCompleteContract([]), false);
  });

  it('rejects a contract missing outcome', () => {
    const { normalized } = validateAuthoredRequest(GOOD);
    const c = buildContract(normalized, 'eric@staqs.io');
    delete c.outcome;
    assert.equal(isCompleteContract(c), false);
  });

  it('rejects a contract with too few criteria', () => {
    const { normalized } = validateAuthoredRequest(GOOD);
    const c = buildContract(normalized, 'eric@staqs.io');
    c.criteria = c.criteria.slice(0, 1);
    assert.equal(isCompleteContract(c), false);
  });

  it('rejects a contract with a stubbed-out short criterion (tamper)', () => {
    const { normalized } = validateAuthoredRequest(GOOD);
    const c = buildContract(normalized, 'eric@staqs.io');
    c.criteria[1] = { text: 'x', result: null };
    assert.equal(isCompleteContract(c), false);
  });

  it('rejects a contract with no out-of-scope', () => {
    const { normalized } = validateAuthoredRequest(GOOD);
    const c = buildContract(normalized, 'eric@staqs.io');
    c.out_of_scope = [];
    assert.equal(isCompleteContract(c), false);
  });
});
