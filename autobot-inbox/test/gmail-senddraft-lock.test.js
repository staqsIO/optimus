import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * #493 regression: sendDraft() (the L1+ autonomous auto-send path) must claim
 * the row atomically BEFORE sending — the same double-send guard Plan 014 (#489)
 * added to sendApprovedDraft. The auto-send path has no human in the loop, so an
 * unguarded re-entry (retry / concurrent poll tick) would double-send.
 *
 * SQL-shape + behaviour test with mocked db/auth/googleapis (no live Gmail).
 */

let claimResult = { rowCount: 1, rows: [{ id: 'd1', provider_draft_id: 'gdraft1', account_id: null }] };
let sendCalls = 0;
let sendShouldThrow = false;      // simulate a Gmail send failure
let persistShouldThrow = false;  // simulate the delivered-persist UPDATE failing after a successful send
const calls = [];

const query = async (sql, params) => {
  calls.push({ sql, params });
  // The atomic claim is the only action_proposals UPDATE with RETURNING.
  if (/UPDATE agent_graph\.action_proposals/.test(sql) && /RETURNING/.test(sql)) {
    return claimResult;
  }
  // The delivered persist is the post-send UPDATE that sets provider_sent_id.
  if (/UPDATE agent_graph\.action_proposals/.test(sql) && /provider_sent_id = \$1/.test(sql)) {
    if (persistShouldThrow) throw new Error('db blip on delivered persist');
    return { rowCount: 1, rows: [] };
  }
  if (/UPDATE agent_graph\.action_proposals/.test(sql)) {
    return { rowCount: 1, rows: [] }; // claim-release ('staged')
  }
  return { rows: [], rowCount: 0 };
};

// True iff the SQL is a release-the-claim UPDATE back to 'staged'.
const isRelease = (sql) => /UPDATE agent_graph\.action_proposals/.test(sql) && /send_state\s*=\s*'staged'/.test(sql);

mock.module('../src/db.js', { namedExports: { query } });
mock.module('../src/gmail/auth.js', {
  namedExports: { getAuth: () => ({}), getAuthForAccount: async () => ({}) },
});
mock.module('../src/gmail/client.js', { namedExports: { createDraft: async () => 'gd' } });
mock.module('../src/runtime/infrastructure.js', {
  namedExports: { logCommsIntent: async () => {}, publishEvent: async () => {} },
});
mock.module('googleapis', {
  namedExports: {
    google: {
      gmail: () => ({
        users: { drafts: { send: async () => {
          sendCalls++;
          if (sendShouldThrow) throw new Error('gmail 500');
          return { data: { id: 'sent1' } };
        } } },
      }),
    },
  },
});

process.env.AUTONOMY_LEVEL = '1'; // sendDraft requires L1+ (read at call time)
const { sendDraft } = await import('../src/gmail/sender.js');

const CLAIM_SQL =
  /UPDATE agent_graph\.action_proposals[\s\S]*send_state\s*=\s*'sending'[\s\S]*WHERE id = \$1 AND provider_sent_id IS NULL AND send_state != 'sending'[\s\S]*RETURNING/;

describe('sendDraft — atomic send-lock (#493)', () => {
  beforeEach(() => { calls.length = 0; sendCalls = 0; sendShouldThrow = false; persistShouldThrow = false; claimResult = { rowCount: 1, rows: [{ id: 'd1', provider_draft_id: 'gdraft1', account_id: null }] }; });

  it('claims the row atomically (send_state=sending, provider_sent_id IS NULL) before sending', async () => {
    claimResult = { rowCount: 1, rows: [{ id: 'd1', provider_draft_id: 'gdraft1', account_id: null }] };
    const id = await sendDraft('d1');
    assert.equal(id, 'sent1');

    const claim = calls.find((c) => CLAIM_SQL.test(c.sql));
    assert.ok(claim, 'sendDraft must issue the atomic-claim UPDATE');

    // The claim must precede the Gmail send (no send before a successful claim).
    const claimIdx = calls.findIndex((c) => CLAIM_SQL.test(c.sql));
    assert.equal(claimIdx, 0, 'the atomic claim must be the first query issued');
    assert.equal(sendCalls, 1, 'sends exactly once after claiming');

    // Plain unguarded read must be gone (that was the bug).
    assert.ok(
      !calls.some((c) => /SELECT \* FROM agent_graph\.action_proposals WHERE id = \$1/.test(c.sql)),
      'must not read via an unguarded SELECT before sending',
    );
  });

  it('does NOT send when the claim is lost (already sending/sent) — throws instead', async () => {
    claimResult = { rowCount: 0, rows: [] }; // another caller already holds the lock
    await assert.rejects(sendDraft('d1'), /already sending or sent/);
    assert.equal(sendCalls, 0, 'must not call Gmail send when the claim fails');
  });

  it('releases the claim to staged when the Gmail send FAILS (nothing sent → retriable)', async () => {
    sendShouldThrow = true;
    await assert.rejects(sendDraft('d1'), /gmail 500/);
    assert.equal(sendCalls, 1, 'attempted the send once');
    assert.ok(calls.some((c) => isRelease(c.sql)), 'must release the claim to staged after a send failure');
  });

  it('does NOT release the claim when persist FAILS after a successful send (#536 V-5: no re-send)', async () => {
    // The email is already out. Reverting to staged would let a retry re-send.
    persistShouldThrow = true;
    await assert.rejects(sendDraft('d1'), /delivered persist/);
    assert.equal(sendCalls, 1, 'the send succeeded exactly once');
    assert.ok(
      !calls.some((c) => isRelease(c.sql)),
      'must NOT release to staged after a post-send persist failure — the row stays locked in sending to block re-send',
    );
  });
});
