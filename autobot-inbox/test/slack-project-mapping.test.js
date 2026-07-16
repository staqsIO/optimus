/**
 * test/slack-project-mapping.test.js — unit tests for OPT-46.
 *
 * Tests the mapping CRUD module (slack/project-mapping.js) and the
 * digest assembler (slack/channel-digest.js) with mocked DB, following the
 * same offline/mocked pattern as slack-adapter.test.js and slack-listener-ingest.test.js.
 *
 * Baseline: 21 failures / 4 files — this file must add ZERO new failures.
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock the db module before importing the modules under test ────────────────
let mockQueryFn = null;
mock.module('../src/db.js', {
  namedExports: {
    query: async (...args) => {
      if (!mockQueryFn) throw new Error('mockQueryFn not set');
      return mockQueryFn(...args);
    },
  },
});

// ── Mapping CRUD ──────────────────────────────────────────────────────────────
describe('slack/project-mapping', () => {
  let linkChannel, unlinkChannel, listMappings, getMappingForChannel, getMappingsForEntity;

  before(async () => {
    ({ linkChannel, unlinkChannel, listMappings, getMappingForChannel, getMappingsForEntity } =
      await import('../src/slack/project-mapping.js'));
  });

  describe('linkChannel', () => {
    it('inserts a project mapping and returns the row', async () => {
      const fakeRow = {
        id: 'row-1',
        org_id: 'org-abc',
        slack_channel_id: 'C01ABC',
        entity_type: 'project',
        entity_id: 'proj-1',
        created_by: 'ecgang',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      mockQueryFn = async () => ({ rows: [fakeRow] });

      const result = await linkChannel({
        orgId: 'org-abc',
        slackChannelId: 'C01ABC',
        entityType: 'project',
        entityId: 'proj-1',
        createdBy: 'ecgang',
      });

      assert.deepEqual(result, fakeRow);
    });

    it('throws if orgId is missing', async () => {
      await assert.rejects(
        () => linkChannel({ slackChannelId: 'C01', entityType: 'project', entityId: 'p1' }),
        /orgId required/,
      );
    });

    it('throws if entityType is invalid', async () => {
      await assert.rejects(
        () => linkChannel({ orgId: 'org-1', slackChannelId: 'C01', entityType: 'wiki', entityId: 'p1' }),
        /entityType must be/,
      );
    });

    it('throws if slackChannelId is missing', async () => {
      await assert.rejects(
        () => linkChannel({ orgId: 'org-1', entityType: 'project', entityId: 'p1' }),
        /slackChannelId required/,
      );
    });
  });

  describe('unlinkChannel', () => {
    it('returns true when a row is deleted', async () => {
      mockQueryFn = async () => ({ rows: [{ id: 'row-1' }] });
      const result = await unlinkChannel({ orgId: 'org-abc', slackChannelId: 'C01ABC' });
      assert.equal(result, true);
    });

    it('returns false when no row matched (wrong org or channel)', async () => {
      mockQueryFn = async () => ({ rows: [] });
      const result = await unlinkChannel({ orgId: 'org-abc', slackChannelId: 'C-NOPE' });
      assert.equal(result, false);
    });

    it('throws if orgId is missing', async () => {
      await assert.rejects(
        () => unlinkChannel({ slackChannelId: 'C01' }),
        /orgId required/,
      );
    });
  });

  describe('listMappings', () => {
    it('returns all mappings for an org', async () => {
      const rows = [
        { id: 'r1', org_id: 'org-abc', slack_channel_id: 'C01', entity_type: 'project', entity_id: 'p1' },
        { id: 'r2', org_id: 'org-abc', slack_channel_id: 'C02', entity_type: 'engagement', entity_id: 'e1' },
      ];
      mockQueryFn = async () => ({ rows });
      const result = await listMappings({ orgId: 'org-abc' });
      assert.equal(result.length, 2);
    });

    it('passes entityType and entityId filters', async () => {
      let capturedSql = '';
      let capturedParams = [];
      mockQueryFn = async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      };
      await listMappings({ orgId: 'org-abc', entityType: 'project', entityId: 'proj-1' });
      assert.ok(capturedSql.includes('entity_type'), 'query must filter by entity_type');
      assert.ok(capturedParams.includes('project'), 'params must include entity type value');
      assert.ok(capturedParams.includes('proj-1'), 'params must include entity id value');
    });

    it('throws if orgId is missing', async () => {
      await assert.rejects(() => listMappings({}), /orgId required/);
    });
  });

  describe('getMappingForChannel', () => {
    it('returns a mapping row when found', async () => {
      const row = { id: 'r1', org_id: 'org-abc', slack_channel_id: 'C01', entity_type: 'project', entity_id: 'p1' };
      mockQueryFn = async () => ({ rows: [row] });
      const result = await getMappingForChannel({ orgId: 'org-abc', slackChannelId: 'C01' });
      assert.deepEqual(result, row);
    });

    it('returns null when not found', async () => {
      mockQueryFn = async () => ({ rows: [] });
      const result = await getMappingForChannel({ orgId: 'org-abc', slackChannelId: 'C-GONE' });
      assert.equal(result, null);
    });
  });

  describe('getMappingsForEntity', () => {
    it('returns all channel mappings for a project', async () => {
      const rows = [
        { id: 'r1', slack_channel_id: 'C01', entity_type: 'project', entity_id: 'proj-1' },
      ];
      mockQueryFn = async () => ({ rows });
      const result = await getMappingsForEntity({ entityType: 'project', entityId: 'proj-1' });
      assert.equal(result.length, 1);
      assert.equal(result[0].slack_channel_id, 'C01');
    });

    it('throws if entityType or entityId missing', async () => {
      await assert.rejects(
        () => getMappingsForEntity({ entityType: 'project' }),
        /entityType and entityId required/,
      );
    });
  });
});

// ── Digest assembler ──────────────────────────────────────────────────────────
describe('slack/channel-digest — assembleChannelDigest', () => {
  let assembleChannelDigest;

  before(async () => {
    ({ assembleChannelDigest } = await import('../src/slack/channel-digest.js'));
  });

  it('returns null when nothing moved in last 24h', async () => {
    // DB returns: name lookup → found, work_items query → empty
    let call = 0;
    mockQueryFn = async () => {
      call++;
      if (call === 1) return { rows: [{ name: 'My Project' }] };   // name lookup
      return { rows: [] };                                            // work items
    };
    const result = await assembleChannelDigest({
      entityType: 'project',
      entityId: 'proj-1',
    });
    assert.equal(result, null, 'should return null when nothing moved');
  });

  it('returns formatted message when work items completed', async () => {
    let call = 0;
    mockQueryFn = async () => {
      call++;
      if (call === 1) return { rows: [{ name: 'Alpha Project' }] }; // name lookup
      // work_items query
      return {
        rows: [
          { title: 'Build login page', status: 'completed', updated_at: new Date() },
          { title: 'Write tests', status: 'in_progress', updated_at: new Date() },
        ],
      };
    };
    const result = await assembleChannelDigest({
      entityType: 'project',
      entityId: 'proj-1',
    });
    assert.ok(result, 'should return a message string');
    assert.ok(result.includes('Alpha Project'), 'message should include project name');
    assert.ok(result.includes('Build login page'), 'message should include completed task');
    assert.ok(result.includes('Write tests'), 'message should include in-progress task');
  });
});

// ── Progress poster — gating ──────────────────────────────────────────────────
describe('slack/progress-poster — isProjectDigestEnabled', () => {
  let isProjectDigestEnabled;

  before(async () => {
    ({ isProjectDigestEnabled } = await import('../src/slack/progress-poster.js'));
  });

  it('returns false when SLACK_BOT_TOKEN is not set', () => {
    const orig = process.env.SLACK_BOT_TOKEN;
    const origEnabled = process.env.SLACK_PROJECT_DIGEST_ENABLED;
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_PROJECT_DIGEST_ENABLED = 'true';
    assert.equal(isProjectDigestEnabled(), false);
    process.env.SLACK_BOT_TOKEN = orig || '';
    if (origEnabled !== undefined) process.env.SLACK_PROJECT_DIGEST_ENABLED = origEnabled;
    else delete process.env.SLACK_PROJECT_DIGEST_ENABLED;
  });

  it('returns false when SLACK_PROJECT_DIGEST_ENABLED is not "true"', () => {
    const orig = process.env.SLACK_BOT_TOKEN;
    const origEnabled = process.env.SLACK_PROJECT_DIGEST_ENABLED;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    delete process.env.SLACK_PROJECT_DIGEST_ENABLED;
    assert.equal(isProjectDigestEnabled(), false);
    process.env.SLACK_BOT_TOKEN = orig || '';
    if (origEnabled !== undefined) process.env.SLACK_PROJECT_DIGEST_ENABLED = origEnabled;
    else delete process.env.SLACK_PROJECT_DIGEST_ENABLED;
  });

  it('returns true when both env vars are set', () => {
    const origToken = process.env.SLACK_BOT_TOKEN;
    const origEnabled = process.env.SLACK_PROJECT_DIGEST_ENABLED;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_PROJECT_DIGEST_ENABLED = 'true';
    assert.equal(isProjectDigestEnabled(), true);
    process.env.SLACK_BOT_TOKEN = origToken || '';
    if (origEnabled !== undefined) process.env.SLACK_PROJECT_DIGEST_ENABLED = origEnabled;
    else delete process.env.SLACK_PROJECT_DIGEST_ENABLED;
  });
});

// ── formatProgressMessage ─────────────────────────────────────────────────────
describe('slack/progress-poster — formatProgressMessage', () => {
  let formatProgressMessage;

  before(async () => {
    ({ formatProgressMessage } = await import('../src/slack/progress-poster.js'));
  });

  it('includes project name in output', () => {
    const msg = formatProgressMessage({ entityType: 'project', entityName: 'Beta Launch' });
    assert.ok(msg.includes('Beta Launch'));
    assert.ok(msg.includes('Project'));
  });

  it('includes completed items', () => {
    const msg = formatProgressMessage({
      entityType: 'project',
      entityName: 'X',
      completed: ['Task A', 'Task B'],
    });
    assert.ok(msg.includes('Task A'));
    assert.ok(msg.includes('Task B'));
    assert.ok(msg.includes('Completed'));
  });

  it('includes blocked items', () => {
    const msg = formatProgressMessage({
      entityType: 'engagement',
      entityName: 'Allbirds',
      blocked: ['Waiting on API keys'],
    });
    assert.ok(msg.includes('Waiting on API keys'));
    assert.ok(msg.includes('Blocked'));
    assert.ok(msg.includes('Engagement'));
  });

  it('includes review URL when provided', () => {
    const msg = formatProgressMessage({
      entityType: 'project',
      entityName: 'X',
      reviewUrl: 'board.staqs.io/pipeline',
    });
    assert.ok(msg.includes('board.staqs.io/pipeline'));
  });
});
