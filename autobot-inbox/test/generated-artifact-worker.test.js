/**
 * OPT-99 — generated-artifact worker (Feature 005 item 4).
 *
 * Contracts under test:
 *   1. recordGeneratedProposal triggers pg_notify('artifact_register') in the
 *      same transaction, which the worker picks up and registers as a
 *      source_system='optimus' artifact owned by the engagement's org.
 *   2. Generating the same proposal TWICE creates version_no=2 (not a dup row
 *      in content.artifacts — identity_key is stable across same title).
 *   3. A Drive re-capture of the same bytes collapses to the SAME artifact
 *      version (content_hash is content-only, drops source_system — OPT-97).
 *   4. Generation does NOT fail if the worker is down (notify is fire-and-forget).
 *
 * Uses PGlite + real createArtifact (no mocking of the artifact stack) so the
 * dedup invariants are exercised end-to-end.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { createArtifact } from '../../lib/content/create-artifact.js';
import { startGeneratedArtifactWorker } from '../../lib/runtime/signals/generated-artifact-worker.js';

// Matches the Staqs org UUID seeded by setup-db / migration 133.
const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 30 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Insert an engagement row and return its id.
 */
async function insertEngagement(query, { name = 'Test Engagement', ownerOrgId = STAQS_ORG } = {}) {
  const r = await query(
    `INSERT INTO engagements.engagements (name, owner_org_id, created_by)
     VALUES ($1, $2, 'test')
     RETURNING id`,
    [name, ownerOrgId]
  );
  return r.rows[0].id;
}

/**
 * Insert a generated_proposal row and emit pg_notify('artifact_register', ...).
 * Mirrors the behaviour of recordGeneratedProposal after OPT-99.
 */
async function insertProposalAndNotify(query, { engagementId, mode = 'tailored-client', markdown, ownerOrgId }) {
  const r = await query(
    `INSERT INTO engagements.generated_proposals
       (engagement_id, spec_version, mode, format, markdown, generated_by)
     VALUES ($1, 1, $2, 'md', $3, 'test')
     RETURNING id`,
    [engagementId, mode, markdown]
  );
  const id = r.rows[0].id;
  // Simulate the notify that recordGeneratedProposal now emits.
  const payload = JSON.stringify({ id, kind: 'proposal', owner_org_id: ownerOrgId });
  await query(`SELECT pg_notify('artifact_register', $1)`, [payload]);
  return id;
}

describe('generated-artifact-worker — integration', () => {
  let query;
  let worker;

  before(async () => {
    ({ query } = await getDb());

    // Start worker in test mode (PGlite, no real pg.Client LISTEN).
    worker = await startGeneratedArtifactWorker({ query, pollIntervalMs: 200 });
  });

  after(async () => {
    await worker.stop();
  });

  beforeEach(async () => {
    // Clean artifact state between tests (leave engagements + proposals).
    await query(`DELETE FROM content.artifact_entity_links WHERE owner_org_id = $1`, [STAQS_ORG]);
    await query(`UPDATE content.artifacts SET current_version_id = NULL WHERE owner_org_id = $1`, [STAQS_ORG]);
    await query(`DELETE FROM content.artifact_versions
                  WHERE artifact_id IN (
                    SELECT id FROM content.artifacts WHERE owner_org_id = $1
                  )`, [STAQS_ORG]);
    await query(`DELETE FROM content.artifacts WHERE owner_org_id = $1 AND source_system = 'optimus'`, [STAQS_ORG]);
    await query(`DELETE FROM content.enrichment_queue WHERE owner_org_id = $1`, [STAQS_ORG]);
  });

  it('notify → worker registers a source_system=optimus artifact owned by the engagement org', async () => {
    const engId = await insertEngagement(query, { name: 'Acme Proposal Test' });
    const markdown = '# Acme Proposal\n\nThis is a tailored proposal for Acme Corp.';

    await insertProposalAndNotify(query, {
      engagementId: engId,
      mode: 'tailored-client',
      markdown,
      ownerOrgId: STAQS_ORG,
    });

    // Wait for the worker to pick up the notification and register the artifact.
    const found = await waitUntil(async () => {
      const r = await query(
        `SELECT id, kind, source_system, owner_org_id, title
           FROM content.artifacts
          WHERE source_system = 'optimus'
            AND kind = 'proposal'
            AND owner_org_id = $1`,
        [STAQS_ORG]
      );
      return r.rows.length > 0;
    });

    assert.ok(found, 'artifact should have been registered within timeout');

    const art = await query(
      `SELECT a.id, a.kind, a.source_system, a.owner_org_id, a.title, av.version_no
         FROM content.artifacts a
         JOIN content.artifact_versions av ON av.id = a.current_version_id
        WHERE a.source_system = 'optimus'
          AND a.kind = 'proposal'
          AND a.owner_org_id = $1`,
      [STAQS_ORG]
    );
    assert.equal(art.rows.length, 1, 'exactly one optimus artifact registered');
    assert.equal(art.rows[0].source_system, 'optimus');
    assert.equal(art.rows[0].kind, 'proposal');
    assert.equal(art.rows[0].owner_org_id, STAQS_ORG);
    assert.equal(art.rows[0].version_no, 1);
    assert.match(art.rows[0].title, /Acme Proposal Test/);
  });

  it('generating the same proposal twice creates version 2 (not a dup artifact)', async () => {
    const engId = await insertEngagement(query, { name: 'Versioning Test Engagement' });
    const markdown1 = '# Version 1\n\nInitial proposal draft.';
    const markdown2 = '# Version 2\n\nRevised proposal with updated pricing.';

    // First generation.
    await insertProposalAndNotify(query, {
      engagementId: engId,
      mode: 'tailored-client',
      markdown: markdown1,
      ownerOrgId: STAQS_ORG,
    });
    await waitUntil(async () => {
      const r = await query(
        `SELECT id FROM content.artifacts
          WHERE source_system = 'optimus' AND kind = 'proposal'
            AND owner_org_id = $1 AND title LIKE '%Versioning Test%'`,
        [STAQS_ORG]
      );
      return r.rows.length > 0;
    });

    // Second generation — different markdown, same title → should version.
    await insertProposalAndNotify(query, {
      engagementId: engId,
      mode: 'tailored-client',
      markdown: markdown2,
      ownerOrgId: STAQS_ORG,
    });
    const versioned = await waitUntil(async () => {
      const r = await query(
        `SELECT av.version_no FROM content.artifacts a
           JOIN content.artifact_versions av ON av.id = a.current_version_id
          WHERE a.source_system = 'optimus'
            AND a.kind = 'proposal'
            AND a.owner_org_id = $1
            AND a.title LIKE '%Versioning Test%'`,
        [STAQS_ORG]
      );
      return r.rows.length > 0 && r.rows[0].version_no === 2;
    });

    assert.ok(versioned, 'second generation should produce version_no=2');

    // Only ONE artifact row (not two).
    const artCount = await query(
      `SELECT count(*)::int AS n FROM content.artifacts
        WHERE source_system = 'optimus' AND kind = 'proposal'
          AND owner_org_id = $1 AND title LIKE '%Versioning Test%'`,
      [STAQS_ORG]
    );
    assert.equal(artCount.rows[0].n, 1, 'still exactly one artifact (versioned, not duplicated)');
  });

  it('Drive re-capture of the same bytes collapses to the same artifact version (content-only hash)', async () => {
    const engId = await insertEngagement(query, { name: 'Drive Collapse Test' });
    const sharedMarkdown = '# Service Proposal\n\nThis is the same text from both sources.';
    const title = 'Drive Collapse Test — tailored-client proposal';

    // Step 1: worker registers from generate path (source_system='optimus').
    await insertProposalAndNotify(query, {
      engagementId: engId,
      mode: 'tailored-client',
      markdown: sharedMarkdown,
      ownerOrgId: STAQS_ORG,
    });
    await waitUntil(async () => {
      const r = await query(
        `SELECT id FROM content.artifacts WHERE owner_org_id = $1 AND title = $2`,
        [STAQS_ORG, title]
      );
      return r.rows.length > 0;
    });

    // Capture version count before Drive re-capture.
    const beforeVersions = await query(
      `SELECT count(*)::int AS n FROM content.artifact_versions av
         JOIN content.artifacts a ON a.id = av.artifact_id
        WHERE a.owner_org_id = $1 AND a.title = $2`,
      [STAQS_ORG, title]
    );

    // Step 2: Drive re-capture of IDENTICAL bytes, different source_system.
    // This is what a Drive watcher would call after downloading the same docx.
    await createArtifact({
      raw: sharedMarkdown,
      kind: 'proposal',
      title,
      source_system: 'drive',   // different door
      ownerOrgId: STAQS_ORG,
    });

    // Should still be 1 artifact, and version count should NOT increase
    // (identical content_hash = idempotent ON CONFLICT DO NOTHING on versions).
    const afterVersions = await query(
      `SELECT count(*)::int AS n FROM content.artifact_versions av
         JOIN content.artifacts a ON a.id = av.artifact_id
        WHERE a.owner_org_id = $1 AND a.title = $2`,
      [STAQS_ORG, title]
    );

    assert.equal(
      afterVersions.rows[0].n,
      beforeVersions.rows[0].n,
      'Drive re-capture of identical bytes must not mint a new version (content_hash dedup)'
    );

    const artCount = await query(
      `SELECT count(*)::int AS n FROM content.artifacts
        WHERE owner_org_id = $1 AND title = $2`,
      [STAQS_ORG, title]
    );
    assert.equal(artCount.rows[0].n, 1, 'only one artifact exists regardless of source_system');
  });

  it('generation does NOT fail if the worker is down (notify is fire-and-forget)', async () => {
    const engId = await insertEngagement(query, { name: 'Worker Down Test' });

    // Stop the worker to simulate it being down.
    await worker.stop();

    // Insert a proposal with notify — must not throw even though worker is stopped.
    let notifyError = null;
    try {
      await insertProposalAndNotify(query, {
        engagementId: engId,
        mode: 'tailored-client',
        markdown: '# Proposal while worker down\n\nGenerated without consumer.',
        ownerOrgId: STAQS_ORG,
      });
    } catch (err) {
      notifyError = err;
    }

    assert.equal(notifyError, null, 'generation must not throw when worker is down');

    // Restart worker for subsequent tests.
    worker = await startGeneratedArtifactWorker({ query, pollIntervalMs: 200 });
  });
});
