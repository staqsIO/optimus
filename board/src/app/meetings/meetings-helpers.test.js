// Tests for /meetings pure helpers.
// FR-38: task-count badge + jump-to-board deep link.
//
// Per ADR-004: pure-function frontend tests run under node:test.
//
// Run: cd board && node --test src/app/meetings/meetings-helpers.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTaskCountBadge,
  meetingTaskLinkUrl,
} from './meetings-helpers.js';

describe('formatTaskCountBadge', () => {
  it('returns "No tasks" for 0', () => {
    assert.equal(formatTaskCountBadge(0), 'No tasks');
  });

  it('singularises for 1', () => {
    assert.equal(formatTaskCountBadge(1), '1 task → Linear');
  });

  it('pluralises for 3', () => {
    assert.equal(formatTaskCountBadge(3), '3 tasks → Linear');
  });

  it('pluralises for 2', () => {
    assert.equal(formatTaskCountBadge(2), '2 tasks → Linear');
  });

  it('normalises negative / NaN / non-numeric to "No tasks"', () => {
    assert.equal(formatTaskCountBadge(-1), 'No tasks');
    assert.equal(formatTaskCountBadge(Number.NaN), 'No tasks');
    assert.equal(formatTaskCountBadge(null), 'No tasks');
    assert.equal(formatTaskCountBadge(undefined), 'No tasks');
  });

  it('floors fractional counts', () => {
    assert.equal(formatTaskCountBadge(2.7), '2 tasks → Linear');
    assert.equal(formatTaskCountBadge(1.4), '1 task → Linear');
  });
});

describe('meetingTaskLinkUrl', () => {
  it('builds /issues URL with signal_meeting_id', () => {
    assert.equal(
      meetingTaskLinkUrl('msg-42'),
      '/issues?signal_meeting_id=msg-42',
    );
  });

  it('encodes ids containing special characters', () => {
    assert.equal(
      meetingTaskLinkUrl('msg/with+chars 1'),
      '/issues?signal_meeting_id=msg%2Fwith%2Bchars%201',
    );
  });

  it('handles empty / null ids without throwing', () => {
    assert.equal(meetingTaskLinkUrl(''), '/issues?signal_meeting_id=');
    assert.equal(meetingTaskLinkUrl(null), '/issues?signal_meeting_id=');
  });
});
