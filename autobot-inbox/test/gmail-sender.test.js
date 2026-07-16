import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Plan 014 regression: createGmailDraft must NOT clobber the 'sending' lock.
 *
 * sendApprovedDraft claims a row atomically (send_state='sending'). When it then
 * calls createGmailDraft mid-send, the draft-record UPDATE used to force
 * send_state='staged', reopening the claim window and allowing a concurrent
 * caller to re-claim and double-send. The fix guards the downgrade with a CASE
 * that preserves 'sending'. We assert the SQL the function issues carries that
 * guard (the fallback pin the plan sanctions when there is no live DB harness).
 */

// Record every query the module issues so we can inspect the UPDATE SQL.
const calls = [];
const query = async (sql, params) => {
  calls.push({ sql, params });
  if (/SELECT \* FROM agent_graph\.action_proposals/.test(sql)) {
    return {
      rows: [{
        id: 'd1',
        message_id: 'm1',
        to_addresses: ['recipient@example.com'],
        subject: 'Hi',
        body: 'body text',
        board_edited_body: null,
        account_id: null,
      }],
    };
  }
  if (/SELECT \* FROM inbox\.messages/.test(sql)) {
    return { rows: [{ subject: 'Original', thread_id: 't1', message_id: '<orig@id>' }] };
  }
  if (/UPDATE agent_graph\.action_proposals/.test(sql)) {
    return { rowCount: 1, rows: [] };
  }
  return { rows: [], rowCount: 0 };
};

mock.module('../src/db.js', { namedExports: { query } });
mock.module('../src/gmail/client.js', {
  namedExports: { createDraft: async () => 'gmail_draft_abc' },
});
mock.module('../src/runtime/infrastructure.js', {
  namedExports: { logCommsIntent: async () => {}, publishEvent: async () => {} },
});

const { createGmailDraft } = await import('../src/gmail/sender.js');

describe('createGmailDraft — send-lock preservation (Plan 014)', () => {
  it("guards the send_state downgrade with a CASE that preserves 'sending'", async () => {
    calls.length = 0;
    const gmailDraftId = await createGmailDraft('d1');
    assert.equal(gmailDraftId, 'gmail_draft_abc');

    const update = calls.find(c => /UPDATE agent_graph\.action_proposals/.test(c.sql));
    assert.ok(update, 'createGmailDraft issued an UPDATE on action_proposals');

    // The load-bearing guard: reverting Step 1 (plain send_state='staged') makes
    // this assertion fail.
    assert.match(
      update.sql,
      /CASE WHEN send_state = 'sending' THEN send_state ELSE 'staged' END/,
      'UPDATE must preserve an in-progress send_state=\'sending\' claim'
    );

    // The unconditional force to 'staged' must be gone.
    assert.doesNotMatch(
      update.sql,
      /send_state\s*=\s*'staged'\s*,\s*updated_at/,
      'must not unconditionally set send_state=\'staged\''
    );
  });
});
