/**
 * RED — board/src/app/governance/guardrails/decisions.js does not exist.
 *
 * FR-22 (Settings → LLM Guardrails — "Last 10 decisions" panel).
 *
 * Pure helper:
 *
 *   formatDecisionForDisplay(row) → { summary, link }
 *     summary: "<title> → <linear_issue_id or 'no issue'> (<outcome>)"
 *     link:    row.linear_issue_url or null
 *
 * Side-effect free — no I/O. ADR-004: pure JS + JSDoc, node:test only.
 * Run: cd board && node --test src/app/governance/guardrails/decisions.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDecisionForDisplay } from './decisions.js';

describe('formatDecisionForDisplay', () => {
  it('summary references linear_issue_id when present', () => {
    const row = {
      task_id: 'htm-1',
      title: 'Ship the thing',
      linear_issue_id: 'LIN-123',
      linear_issue_url: 'https://linear.app/staqs/issue/LIN-123',
      outcome: 'success',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(out.summary, 'Ship the thing → LIN-123 (success)');
  });

  it("summary references 'no issue' when linear_issue_id is absent", () => {
    const row = {
      task_id: 'htm-2',
      title: 'Nothing pushed yet',
      linear_issue_id: null,
      linear_issue_url: null,
      outcome: 'skipped',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(out.summary, 'Nothing pushed yet → no issue (skipped)');
  });

  it("summary references 'no issue' when linear_issue_id is undefined", () => {
    const row = {
      task_id: 'htm-3',
      title: 'Undef issue',
      outcome: 'failed',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(out.summary, 'Undef issue → no issue (failed)');
  });

  it("summary references 'no issue' when linear_issue_id is empty string", () => {
    const row = {
      title: 'Empty id',
      linear_issue_id: '',
      outcome: 'success',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(out.summary, 'Empty id → no issue (success)');
  });

  it("outcome='skipped' is reflected in summary", () => {
    const row = {
      title: 'Was skipped',
      linear_issue_id: 'LIN-99',
      outcome: 'skipped',
    };
    const out = formatDecisionForDisplay(row);
    assert.match(out.summary, /\(skipped\)$/);
  });

  it('link returns linear_issue_url when present', () => {
    const row = {
      title: 't',
      linear_issue_id: 'LIN-7',
      linear_issue_url: 'https://linear.app/staqs/issue/LIN-7',
      outcome: 'success',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(
      out.link,
      'https://linear.app/staqs/issue/LIN-7',
    );
  });

  it('link returns null when linear_issue_url is missing', () => {
    const row = {
      title: 't',
      linear_issue_id: null,
      outcome: 'skipped',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(out.link, null);
  });

  it('link returns null when linear_issue_url is empty string', () => {
    const row = {
      title: 't',
      linear_issue_id: 'LIN-1',
      linear_issue_url: '',
      outcome: 'success',
    };
    const out = formatDecisionForDisplay(row);
    assert.strictEqual(out.link, null);
  });

  it('handles missing title gracefully', () => {
    const row = {
      linear_issue_id: 'LIN-1',
      outcome: 'success',
    };
    const out = formatDecisionForDisplay(row);
    // Don't crash; placeholder for missing title.
    assert.ok(typeof out.summary === 'string');
    assert.match(out.summary, /LIN-1.*success/);
  });
});
