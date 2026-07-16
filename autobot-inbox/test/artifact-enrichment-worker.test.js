/**
 * OPT-93 — artifact enrichment worker (Feature 004 item 2).
 *
 * The consumer over content.enrichment_queue (producer + pg_notify trigger
 * shipped in OPT-92 / migration 154). Mirrors enrichment-worker.test.js: real
 * PGlite + an injectable `extractEntities` so we exercise the worker plumbing
 * + resolver without going near a real LLM.
 *
 * Contract under test:
 *   - claim is atomic: two workers do not double-process one queue row.
 *   - known-email mention auto-links the existing contact (link_status='auto').
 *   - ambiguous NAME-only mention lands as link_status='pending' (no contact insert).
 *   - a NEW-email person inserts a contact (owner-stamped) and auto-links it.
 *   - derived_facts are idempotent on re-enrichment (provenance_hash unique).
 *   - an enrichment error increments attempts, then → 'failed' at 3 attempts.
 *   - TENANCY: a Staqs artifact never links/writes a UMB contact.
 *   - G10 hard cap: over the daily cap, the row is left 'pending' (fail-closed).
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { startArtifactEnrichmentWorker } from '../../lib/runtime/signals/artifact-enrichment-worker.js';

const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const UMB_ORG = '22222222-2222-2222-2222-222222222222';
const MEMBER = 'cccccccc-0000-0000-0000-0000000000c3';

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

let seq = 0;
// Seed an artifact + version + document + queue row, all owner-stamped to `org`.
// Returns { artifactId, documentId, versionId, queueId }.
async function seedArtifact(query, { org, body, title = 'OPT-93 test artifact', enqueue = true } = {}) {
  seq += 1;
  const docRes = await query(
    `INSERT INTO content.documents (source, source_id, title, raw_text, format, owner_id, owner_org_id)
     VALUES ('artifact', $1, $2, $3, 'markdown', $4, $5)
     RETURNING id`,
    [`opt93-${seq}-${Math.random().toString(36).slice(2, 8)}`, title, body, MEMBER, org],
  );
  const documentId = docRes.rows[0].id;

  const artRes = await query(
    `INSERT INTO content.artifacts (kind, title, source_system, identity_key, owner_org_id, owner_id, created_by)
     VALUES ('doc', $1, 'mcp', $2, $3, $4, $4)
     RETURNING id`,
    [title, `opt93-ident-${seq}-${Math.random().toString(36).slice(2, 8)}`, org, MEMBER],
  );
  const artifactId = artRes.rows[0].id;

  const verRes = await query(
    `INSERT INTO content.artifact_versions (artifact_id, version_no, document_id, content_hash, owner_org_id)
     VALUES ($1, 1, $2, $3, $4)
     RETURNING id`,
    [artifactId, documentId, `hash-${seq}-${Math.random().toString(36).slice(2, 8)}`, org],
  );
  const versionId = verRes.rows[0].id;
  await query(`UPDATE content.artifacts SET current_version_id = $1 WHERE id = $2`, [versionId, artifactId]);

  let queueId = null;
  if (enqueue) {
    const qRes = await query(
      `INSERT INTO content.enrichment_queue (document_id, artifact_id, owner_org_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [documentId, artifactId, org],
    );
    queueId = qRes.rows[0].id;
  }
  return { artifactId, documentId, versionId, queueId };
}

async function queueRow(query, id) {
  const r = await query(`SELECT * FROM content.enrichment_queue WHERE id = $1`, [id]);
  return r.rows[0];
}

describe('artifact-enrichment-worker — integration', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // board_members row satisfies the owner_id FK on content.documents.
    await query(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
       VALUES ($1, 'opt93-test', 'OPT-93 Test', 'member')
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER],
    );

    // A UMB org so the tenancy test has a second tenant. (Staqs already exists
    // from migration 133.)
    await query(
      `INSERT INTO tenancy.orgs (id, slug, name)
       VALUES ($1, 'umb-opt93', 'UMB OPT-93 Test')
       ON CONFLICT (id) DO NOTHING`,
      [UMB_ORG],
    ).catch(() => { /* tenancy.orgs shape varies; org id is what matters for the column */ });

    // Known contacts. Eric (Staqs) by email; an ambiguous "Chris" pair (Staqs)
    // for the trigram-pending case.
    await query(
      `INSERT INTO signal.contacts (id, email_address, name, owner_org_id)
       VALUES ('opt93-eric', 'eric@staqs.io', 'Eric Gang', $1)
       ON CONFLICT (email_address) DO NOTHING`,
      [STAQS_ORG],
    );
    await query(
      `INSERT INTO signal.contacts (id, email_address, name, owner_org_id)
       VALUES ('opt93-chris', 'chris@staqs.io', 'Christopher Bell', $1)
       ON CONFLICT (email_address) DO NOTHING`,
      [STAQS_ORG],
    );
    // A UMB-owned contact with the SAME email pattern is impossible (email is
    // unique org-wide), so the tenancy test seeds a UMB contact under UMB_ORG.
    await query(
      `INSERT INTO signal.contacts (id, email_address, name, owner_org_id)
       VALUES ('opt93-umb', 'partner@umb.example', 'UMB Partner', $1)
       ON CONFLICT (email_address) DO NOTHING`,
      [UMB_ORG],
    );
  });

  beforeEach(async () => {
    // Clear queue + this suite's links/facts/inserted contacts between tests.
    await query(`DELETE FROM content.enrichment_queue`);
    await query(`DELETE FROM content.artifact_entity_links WHERE owner_org_id IN ($1,$2)`, [STAQS_ORG, UMB_ORG]);
    await query(`DELETE FROM content.derived_facts WHERE owner_org_id IN ($1,$2)`, [STAQS_ORG, UMB_ORG]);
    await query(`DELETE FROM signal.contacts WHERE email_address LIKE 'new-%@staqs.io'`);
  });

  it('known-email mention auto-links the existing contact (>= 0.85)', async () => {
    const { artifactId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Eric to ship the migration.' });

    const extractEntities = async () => ({
      entities: [{ type: 'person', value: 'Eric Gang <eric@staqs.io>', snippet: 'Eric to ship the migration.' }],
    });

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 50 });
    try {
      await waitUntil(async () => {
        const r = await query(
          `SELECT link_status FROM content.artifact_entity_links
            WHERE artifact_id = $1 AND entity_type = 'contact' AND entity_id = 'opt93-eric'`,
          [artifactId],
        );
        return r.rows.length === 1 && r.rows[0].link_status === 'auto';
      });
    } finally {
      await worker.stop();
    }

    const link = await query(
      `SELECT link_status, confidence, owner_org_id FROM content.artifact_entity_links
        WHERE artifact_id = $1 AND entity_id = 'opt93-eric'`,
      [artifactId],
    );
    assert.equal(link.rows[0].link_status, 'auto');
    assert.equal(link.rows[0].owner_org_id, STAQS_ORG);
    assert.ok(Number(link.rows[0].confidence) >= 0.85);
  });

  it('BARE-EMAIL mention (no name) still auto-links — email is the identity key (Linus M1)', async () => {
    // Regression guard: a bare email with no parsed name (common in transcripts,
    // mailto:, calendar attendees) must auto-link, NOT land in the human queue.
    // Pre-fix this scored 0.70 → pending; a scoped exact-email match is identity.
    const { artifactId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Ping eric@staqs.io re: the migration.' });

    const extractEntities = async () => ({
      entities: [{ type: 'person', value: 'eric@staqs.io', snippet: 'Ping eric@staqs.io re: the migration.' }],
    });

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 50 });
    try {
      await waitUntil(async () => {
        const r = await query(
          `SELECT link_status FROM content.artifact_entity_links
            WHERE artifact_id = $1 AND entity_type = 'contact' AND entity_id = 'opt93-eric'`,
          [artifactId],
        );
        return r.rows.length === 1 && r.rows[0].link_status === 'auto';
      });
    } finally {
      await worker.stop();
    }

    const link = await query(
      `SELECT link_status, owner_org_id FROM content.artifact_entity_links
        WHERE artifact_id = $1 AND entity_id = 'opt93-eric'`,
      [artifactId],
    );
    assert.equal(link.rows[0].link_status, 'auto', 'bare email → auto, not pending');
    assert.equal(link.rows[0].owner_org_id, STAQS_ORG);
  });

  it('ambiguous NAME-only mention lands as pending (no contact insert)', async () => {
    const { artifactId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Chris will follow up.' });
    const before = await query(`SELECT count(*)::int AS n FROM signal.contacts WHERE owner_org_id = $1`, [STAQS_ORG]);

    // "Christopher" trigram-matches "Christopher Bell" but is not exact and
    // carries no email → name-only band (0.55..0.85) → pending, never an insert.
    const extractEntities = async () => ({
      entities: [{ type: 'person', value: 'Christopher', snippet: 'Chris will follow up.' }],
    });

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 50 });
    try {
      await waitUntil(async () => {
        const r = await query(
          `SELECT link_status FROM content.artifact_entity_links WHERE artifact_id = $1`,
          [artifactId],
        );
        return r.rows.length === 1;
      });
    } finally {
      await worker.stop();
    }

    const link = await query(
      `SELECT entity_id, link_status FROM content.artifact_entity_links WHERE artifact_id = $1`,
      [artifactId],
    );
    assert.equal(link.rows[0].link_status, 'pending', 'ambiguous name → pending review queue');
    const after = await query(`SELECT count(*)::int AS n FROM signal.contacts WHERE owner_org_id = $1`, [STAQS_ORG]);
    assert.equal(after.rows[0].n, before.rows[0].n, 'no contact was inserted for a name-only match');
  });

  it('new-email person inserts a contact (owner-stamped) and auto-links it', async () => {
    const { artifactId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Dana joined the call.' });

    const extractEntities = async () => ({
      entities: [{ type: 'person', value: 'Dana Lee <new-dana@staqs.io>', snippet: 'Dana joined the call.' }],
    });

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 50 });
    try {
      await waitUntil(async () => {
        const r = await query(`SELECT id FROM signal.contacts WHERE email_address = 'new-dana@staqs.io'`);
        return r.rows.length === 1;
      });
    } finally {
      await worker.stop();
    }

    const contact = await query(
      `SELECT id, owner_org_id FROM signal.contacts WHERE email_address = 'new-dana@staqs.io'`,
    );
    assert.equal(contact.rows[0].owner_org_id, STAQS_ORG, 'new contact owner-stamped to artifact org');
    const link = await query(
      `SELECT link_status FROM content.artifact_entity_links
        WHERE artifact_id = $1 AND entity_id = $2`,
      [artifactId, contact.rows[0].id],
    );
    assert.equal(link.rows[0].link_status, 'auto', 'new-email contact auto-linked');
  });

  it('derived_facts are idempotent across a re-enrichment of the same artifact', async () => {
    const { artifactId, documentId, queueId } = await seedArtifact(query, {
      org: STAQS_ORG, body: 'Eric to ship the migration before EOW.',
    });

    const extractEntities = async () => ({
      entities: [{ type: 'person', value: 'Eric Gang <eric@staqs.io>', snippet: 'Eric to ship the migration before EOW.' }],
    });

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 50 });
    try {
      await waitUntil(async () => (await queueRow(query, queueId))?.status === 'done');

      const facts1 = await query(
        `SELECT count(*)::int AS n FROM content.derived_facts WHERE artifact_id = $1`,
        [artifactId],
      );
      assert.equal(facts1.rows[0].n, 1, 'one fact derived');

      // Re-enqueue the SAME artifact/document → re-enrichment. The provenance
      // hash (entity|fact|document) is identical, so ON CONFLICT DO NOTHING
      // makes it a net-zero no-op.
      const q2 = await query(
        `INSERT INTO content.enrichment_queue (document_id, artifact_id, owner_org_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [documentId, artifactId, STAQS_ORG],
      );
      await waitUntil(async () => (await queueRow(query, q2.rows[0].id))?.status === 'done');

      const facts2 = await query(
        `SELECT count(*)::int AS n FROM content.derived_facts WHERE artifact_id = $1`,
        [artifactId],
      );
      assert.equal(facts2.rows[0].n, 1, 're-enrichment did not duplicate the fact');
    } finally {
      await worker.stop();
    }
  });

  it('an enrichment error increments attempts, then → failed at 3 attempts', async () => {
    const { queueId } = await seedArtifact(query, { org: STAQS_ORG, body: 'whatever' });

    // Always throw → every attempt fails. attempts: 0→1 (pending), 1→2 (pending),
    // 2→3 (failed). The poll loop re-claims a pending row, so it walks to failed.
    const extractEntities = async () => { throw new Error('extractor exploded'); };

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 30 });
    try {
      await waitUntil(async () => (await queueRow(query, queueId))?.status === 'failed', { timeoutMs: 3000 });
    } finally {
      await worker.stop();
    }

    const row = await queueRow(query, queueId);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 3, 'failed after exactly 3 attempts');
  });

  it('claim is atomic — two workers do not double-process one row', async () => {
    const { artifactId, queueId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Eric is here.' });

    let callsA = 0;
    let callsB = 0;
    const extractA = async () => { callsA++; return { entities: [{ type: 'person', value: 'eric@staqs.io' }] }; };
    const extractB = async () => { callsB++; return { entities: [{ type: 'person', value: 'eric@staqs.io' }] }; };

    const wA = await startArtifactEnrichmentWorker({ query, extractEntities: extractA, pollIntervalMs: 40 });
    const wB = await startArtifactEnrichmentWorker({ query, extractEntities: extractB, pollIntervalMs: 40 });
    try {
      await waitUntil(async () => (await queueRow(query, queueId))?.status === 'done');
      await new Promise((r) => setTimeout(r, 120)); // let the loser try + back off
    } finally {
      await wA.stop();
      await wB.stop();
    }

    assert.equal(callsA + callsB, 1, `exactly one worker processed the row; A=${callsA} B=${callsB}`);
    const links = await query(
      `SELECT count(*)::int AS n FROM content.artifact_entity_links WHERE artifact_id = $1`,
      [artifactId],
    );
    assert.equal(links.rows[0].n, 1, 'no duplicate link from a double-process');
  });

  it('TENANCY: a Staqs artifact never links a UMB contact (cross-org email match drops)', async () => {
    // The mention carries the UMB partner's email, but the ARTIFACT is Staqs.
    // The resolver scopes the contact lookup to the artifact's org → no Staqs
    // contact has that email → it is treated as a NEW email. But inserting it
    // would mint a Staqs contact; the cross-org email already exists under UMB,
    // so the ON CONFLICT resolves to the UMB row and the tenancy guard refuses
    // to link it. Net: no link to the UMB contact, no Staqs link to its id.
    const { artifactId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Met the UMB partner.' });

    const extractEntities = async () => ({
      entities: [{ type: 'person', value: 'UMB Partner <partner@umb.example>', snippet: 'Met the UMB partner.' }],
    });

    const worker = await startArtifactEnrichmentWorker({ query, extractEntities, pollIntervalMs: 50 });
    try {
      await waitUntil(async () => {
        const r = await query(`SELECT status FROM content.enrichment_queue WHERE artifact_id = $1`, [artifactId]);
        return r.rows.length === 0 || r.rows[0].status === 'done';
      });
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      await worker.stop();
    }

    // No link to the UMB contact id under the Staqs artifact.
    const umbLink = await query(
      `SELECT count(*)::int AS n FROM content.artifact_entity_links
        WHERE artifact_id = $1 AND entity_id = 'opt93-umb'`,
      [artifactId],
    );
    assert.equal(umbLink.rows[0].n, 0, 'Staqs artifact did NOT link the UMB contact');

    // And no artifact_entity_links row was written under UMB_ORG by a Staqs artifact.
    const crossOrg = await query(
      `SELECT count(*)::int AS n FROM content.artifact_entity_links
        WHERE artifact_id = $1 AND owner_org_id = $2`,
      [artifactId, UMB_ORG],
    );
    assert.equal(crossOrg.rows[0].n, 0, 'no UMB-stamped link from a Staqs artifact');
  });
});

describe('artifact-enrichment-worker — G10 hard cap', () => {
  let query;
  const CAP_AGENT = 'artifact-enricher';

  before(async () => {
    ({ query } = await getDb());
    await query(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
       VALUES ($1, 'opt93-test', 'OPT-93 Test', 'member')
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER],
    );
    // agent_configs row so the llm_invocations FK is satisfied for the spend row.
    await query(
      `INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
       VALUES ($1, 'executor', 'haiku', 'test', 'opt93cap', true)
       ON CONFLICT (id) DO NOTHING`,
      [CAP_AGENT],
    );
  });

  beforeEach(async () => {
    await query(`DELETE FROM content.enrichment_queue`);
    await query(`DELETE FROM agent_graph.llm_invocations WHERE agent_id = $1`, [CAP_AGENT]);
  });

  it('over the daily cap, the queue row is left pending and the extractor is not called', async () => {
    // Seed today's spend well over a tiny cap.
    await query(
      `INSERT INTO agent_graph.llm_invocations
         (agent_id, task_id, model, input_tokens, output_tokens, cost_usd,
          prompt_hash, response_hash, idempotency_key)
       VALUES ($1, 'opt93-cap', 'haiku', 1, 1, 9.99, 'h', 'h', $2)`,
      [CAP_AGENT, `opt93-cap-${Math.random().toString(36).slice(2)}`],
    );

    const { queueId } = await seedArtifact(query, { org: STAQS_ORG, body: 'Eric is here.' });

    let called = 0;
    const extractEntities = async () => { called++; return { entities: [] }; };

    const worker = await startArtifactEnrichmentWorker({
      query, extractEntities, pollIntervalMs: 40, dailyCapUsd: 1,
    });
    try {
      // Give the worker a few ticks to claim + cap-skip the row.
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      await worker.stop();
    }

    assert.equal(called, 0, 'extractor never called when over the G10 cap (fail-closed)');
    const row = await queueRow(query, queueId);
    assert.equal(row.status, 'pending', 'capped row is left pending, not failed');
    assert.equal(row.attempts, 0, 'a cap skip does not burn an attempt');
  });
});
