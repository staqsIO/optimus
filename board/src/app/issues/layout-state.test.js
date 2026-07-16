// STAQPRO-618 Slice B1 — List ⇄ Board layout toggle.
//
// Layout precedence mirrors the view-filter precedence exactly:
//   URL ?layout= > localStorage['board:layout'] > 'board' (default)
// Unknown values are ignored at every level (fall through to the next source).
//
// Pure logic lives in resolveInitialLayout() so it's testable without RTL
// (ADR-004 — same convention as resolveInitialView).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitialLayout, BOARD_LAYOUTS } from './board-filter.js';

describe('BOARD_LAYOUTS export', () => {
  it('exposes exactly the two layout modes in canonical order', () => {
    assert.deepEqual([...BOARD_LAYOUTS], ['board', 'list']);
  });
});

describe('resolveInitialLayout — precedence', () => {
  it('URL ?layout= wins over localStorage and default', () => {
    assert.equal(
      resolveInitialLayout({ urlLayout: 'list', storedLayout: 'board' }),
      'list',
    );
    assert.equal(
      resolveInitialLayout({ urlLayout: 'board', storedLayout: 'list' }),
      'board',
    );
  });

  it('falls back to localStorage when URL is empty/null', () => {
    assert.equal(
      resolveInitialLayout({ urlLayout: null, storedLayout: 'list' }),
      'list',
    );
    assert.equal(
      resolveInitialLayout({ urlLayout: undefined, storedLayout: 'board' }),
      'board',
    );
  });

  it('defaults to "board" when both URL and localStorage are empty', () => {
    assert.equal(resolveInitialLayout({ urlLayout: null, storedLayout: null }), 'board');
    assert.equal(resolveInitialLayout({}), 'board');
    assert.equal(resolveInitialLayout(), 'board');
  });
});

describe('resolveInitialLayout — rejects unknown values silently', () => {
  it('unknown URL value is ignored → falls through to localStorage', () => {
    assert.equal(
      resolveInitialLayout({ urlLayout: 'galaxy', storedLayout: 'list' }),
      'list',
    );
  });

  it('unknown URL + unknown localStorage → default "board"', () => {
    assert.equal(
      resolveInitialLayout({ urlLayout: 'galaxy', storedLayout: 'kanban' }),
      'board',
    );
  });

  it('empty-string values are not valid → fall through', () => {
    assert.equal(resolveInitialLayout({ urlLayout: '', storedLayout: '' }), 'board');
    assert.equal(resolveInitialLayout({ urlLayout: '', storedLayout: 'list' }), 'list');
  });
});
