/**
 * Engagements data access — typed CRUD wrappers over the `engagements` schema.
 *
 * All callers (API routes, ingest, synth) go through these helpers; they
 * never write raw SQL elsewhere. Parameterized queries only (P4).
 *
 * Pin enforcement lives in synth.js (apply phase) — this layer is pure
 * persistence. Audit rows are written here for any mutation that has one.
 */

import { query, withTransaction } from '../db.js';
import { visibleClause, syntheticPrincipal, CURRENT_ORG_ID } from '../tenancy/scope.js';

// STAQPRO-618: agent-runtime / system callers (auto-build, synth, contract
// drafter, exporter, signature completion) have no request viewer. They run
// org-wide on the single operational org today; scope them to CURRENT_ORG (Staqs)
// rather than adminBypass so generated/derived reads can never leak across orgs
// once a second org exists. HTTP routes pass the request principal instead.
export const SYSTEM_PRINCIPAL = syntheticPrincipal(CURRENT_ORG_ID);

// STAQPRO-618 (ADR-015): 'advisory' joins the build kinds for non-software work.
const ENGAGEMENT_KINDS = new Set(['website', 'mobile_app', 'api', 'other', 'advisory']);
// STAQPRO-618 (ADR-015): deal lifecycle replaces the original 3-state authoring
// set. A menu, not a turnstile — any status may follow any other; this set is
// only the closed vocabulary of valid values (mirrors the migration-150 CHECK).
const ENGAGEMENT_STATUSES = new Set([
  'prospect', 'proposed', 'won', 'active', 'closed', 'lost', 'archived',
]);
const PROPOSAL_KINDS = new Set(['draft', 'finalized', 'note']);
const PROPOSAL_SOURCES = new Set(['paste', 'upload', 'url']);
const PIN_STATES = new Set(['unpinned', 'pinned']);

// ============================================================
// engagements
// ============================================================

export async function createEngagement({
  name, client, kind = 'other', createdBy, ownerOrgId = null, status = 'prospect',
}) {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  if (!ENGAGEMENT_KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`);
  if (!ENGAGEMENT_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);

  // STAQPRO-618: owner_org_id is stamped from the verified WRITER's principal
  // (owner-stamp.js writerOrgId), never from the request body. A null ownerOrgId
  // means "let the column DEFAULT apply" (Staqs, single-org-correct today) — so
  // we omit the column from the INSERT entirely rather than writing NULL, which
  // the fail-closed read path would then never surface.
  if (ownerOrgId) {
    const r = await query(
      `INSERT INTO engagements.engagements (name, client, kind, status, created_by, owner_org_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name.trim(), client || null, kind, status, createdBy || null, ownerOrgId]
    );
    return r.rows[0];
  }
  const r = await query(
    `INSERT INTO engagements.engagements (name, client, kind, status, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name.trim(), client || null, kind, status, createdBy || null]
  );
  return r.rows[0];
}

export async function listEngagements({ status, principal } = {}) {
  if (status && !ENGAGEMENT_STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  // STAQPRO-618: org-scope the list fail-closed. status is the first positional
  // param; visibleClause params follow it (startIndex: 2).
  const v = visibleClause(principal, { ownerOrgCol: 'e.owner_org_id', startIndex: 2 });
  const r = await query(
    `SELECT e.*,
            (SELECT count(*) FROM engagements.proposals p
              WHERE p.engagement_id = e.id) AS proposal_count,
            (SELECT last_synth_at FROM engagements.specs s
              WHERE s.engagement_id = e.id) AS last_synth_at,
            (SELECT substring(ss.body, 1, 240)
               FROM engagements.spec_sections ss
               JOIN engagements.specs sp ON sp.id = ss.spec_id
              WHERE sp.engagement_id = e.id
                AND ss.section_key IN ('overview', 'our_understanding', 'scope')
                AND length(coalesce(ss.body, '')) > 0
              ORDER BY CASE ss.section_key
                WHEN 'overview' THEN 1
                WHEN 'our_understanding' THEN 2
                ELSE 3 END,
                ss.ordinal
              LIMIT 1) AS summary
       FROM engagements.engagements e
      WHERE ($1::text IS NULL OR e.status = $1)
        AND ${v.sql}
      ORDER BY e.updated_at DESC`,
    [status || null, ...v.params]
  );
  return r.rows;
}

/**
 * Stamp the engagement with a current async-job status the UI can poll.
 * status: 'ingesting' | 'synthesizing' | 'generating' | 'drafting_contract' | null (to clear)
 * progress: arbitrary jsonb the UI renders (e.g., { stage, current, total, label })
 */
export async function setEngagementAsyncStatus(id, { status, progress = {} } = {}) {
  if (status === null) {
    await query(
      `UPDATE engagements.engagements
          SET async_status = NULL, async_started_at = NULL, async_progress = '{}'::jsonb
        WHERE id = $1`,
      [id]
    );
    return;
  }
  if (!['ingesting', 'synthesizing', 'generating', 'drafting_contract'].includes(status)) {
    throw new Error(`invalid async_status: ${status}`);
  }
  await query(
    `UPDATE engagements.engagements
        SET async_status = $2,
            async_started_at = COALESCE(async_started_at, now()),
            async_progress = $3::jsonb
      WHERE id = $1`,
    [id, status, JSON.stringify(progress || {})]
  );
}

export async function updateEngagementAsyncProgress(id, progress) {
  await query(
    `UPDATE engagements.engagements
        SET async_progress = $2::jsonb
      WHERE id = $1 AND async_status IS NOT NULL`,
    [id, JSON.stringify(progress || {})]
  );
}

export async function clearEngagementAsyncStatus(id) {
  return setEngagementAsyncStatus(id, { status: null });
}

export async function getEngagement(id, { principal } = {}) {
  // STAQPRO-618: org-scope fail-closed. id is $1; visibleClause params follow.
  const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
  const r = await query(
    `SELECT * FROM engagements.engagements WHERE id = $1 AND ${v.sql}`,
    [id, ...v.params]
  );
  return r.rows[0] || null;
}

/**
 * Return the singleton master engagement, if one exists.
 * Migration 116 guarantees there's exactly one; this helper is the only
 * entry point so callers don't accidentally treat "no master" as a normal state.
 */
export async function getMasterEngagement() {
  const r = await query(
    `SELECT * FROM engagements.engagements WHERE is_master = true LIMIT 1`
  );
  return r.rows[0] || null;
}

/**
 * Load the master's current spec sections in order. Returns [] if the master
 * has never been synthesized (or has no sections yet). Non-master synth uses
 * this to inject inherited baseline standards into the prompt.
 */
export async function getMasterSections() {
  const master = await getMasterEngagement();
  if (!master) return { master: null, sections: [] };
  const spec = await getSpecByEngagement(master.id);
  if (!spec) return { master, sections: [] };
  const sections = await listSections(spec.id);
  return { master, sections };
}

/**
 * Load every non-master engagement that has at least one synthesized section.
 * Used by master synth to distill baseline patterns from real client work
 * instead of forcing the user to hand-author baselines.
 *
 * Returns: [{ engagement, sections }]. Engagements with zero sections (never
 * synthesized) are excluded — they contribute no signal.
 */
export async function getChildEngagementSpecs() {
  const r = await query(
    `SELECT e.id AS engagement_id, e.name, e.client, e.kind, e.status,
            s.id AS spec_id
       FROM engagements.engagements e
       JOIN engagements.specs s ON s.engagement_id = e.id
      WHERE e.is_master = false
        AND EXISTS (SELECT 1 FROM engagements.spec_sections ss WHERE ss.spec_id = s.id)
      ORDER BY e.updated_at DESC`
  );
  if (r.rows.length === 0) return [];

  const specIds = r.rows.map((row) => row.spec_id);
  const sec = await query(
    `SELECT spec_id, section_key, title, body, ordinal, is_core
       FROM engagements.spec_sections
      WHERE spec_id = ANY($1::uuid[])
      ORDER BY spec_id, ordinal ASC`,
    [specIds]
  );

  const bySpec = new Map();
  for (const s of sec.rows) {
    if (!bySpec.has(s.spec_id)) bySpec.set(s.spec_id, []);
    bySpec.get(s.spec_id).push(s);
  }

  return r.rows.map((row) => ({
    engagement: {
      id: row.engagement_id,
      name: row.name,
      client: row.client,
      kind: row.kind,
      status: row.status,
    },
    sections: bySpec.get(row.spec_id) || [],
  }));
}

/**
 * Hard-delete an engagement and everything under it (cascade via FKs).
 * Refuses to delete the master engagement.
 */
export async function deleteEngagement(id) {
  const r = await query(
    `DELETE FROM engagements.engagements
      WHERE id = $1 AND is_master = false
      RETURNING id, name, client`,
    [id]
  );
  return r.rows[0] || null;
}

/**
 * Renumber a spec's section ordinals to 1..N in their current display order.
 * Useful after deletes to keep gaps from growing or after accepts that
 * landed a section at the same ordinal as an existing one.
 */
export async function normalizeSectionOrdinals(specId, client = null) {
  const q = client?.query ? client.query.bind(client) : query;
  await q(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY ordinal, created_at) AS rn
         FROM engagements.spec_sections WHERE spec_id = $1
     )
     UPDATE engagements.spec_sections s
        SET ordinal = ranked.rn
       FROM ranked
      WHERE s.id = ranked.id AND s.ordinal <> ranked.rn`,
    [specId]
  );
}

export async function updateEngagementStatus(id, status) {
  // STAQPRO-618: validate against the deal-lifecycle set, but allow ANY -> ANY
  // transition (a menu, not a turnstile — the board moves a deal between stages
  // freely). The DB CHECK is the closed vocabulary; ordering is a UI affordance.
  if (!ENGAGEMENT_STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const r = await query(
    `UPDATE engagements.engagements SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return r.rows[0] || null;
}

/**
 * STAQPRO-618: flip an engagement to 'won' when its contract is fully signed.
 * Idempotent and non-downgrading — only advances a deal that is still in a
 * pre-win stage. We refuse to overwrite 'won' (already there), 'active' (the
 * project is already underway — winning it again is meaningless and would reset
 * the stage), or 'closed' (a finished engagement). Best-effort: returns the
 * (possibly unchanged) row, or null if the engagement is gone.
 *
 * Called from the signature-completion hook (lib/signatures/signer.js), wrapped
 * in the caller's try/catch so a lifecycle blip never breaks signing.
 */
export async function markEngagementWon(engagementId) {
  if (!engagementId) return null;
  const r = await query(
    `UPDATE engagements.engagements
        SET status = 'won', updated_at = now()
      WHERE id = $1
        AND status NOT IN ('won', 'active', 'closed')
      RETURNING *`,
    [engagementId]
  );
  if (r.rows[0]) return r.rows[0];
  // No update happened: either the engagement doesn't exist, or it's already in
  // a stage we won't downgrade. Return the current row (or null) so the caller
  // can log meaningfully without treating "already won" as an error.
  const cur = await query(
    `SELECT * FROM engagements.engagements WHERE id = $1`,
    [engagementId]
  );
  return cur.rows[0] || null;
}

// ============================================================
// proposals
// ============================================================

export async function insertProposal({
  engagementId,
  title,
  kind = 'draft',
  sourceType,
  sourceUri,
  rawContent,
  parsedMarkdown,
  embedding,
  createdBy,
}) {
  if (!PROPOSAL_KINDS.has(kind)) throw new Error(`invalid proposal kind: ${kind}`);
  if (!PROPOSAL_SOURCES.has(sourceType)) {
    throw new Error(`invalid source_type: ${sourceType}`);
  }
  if (!parsedMarkdown) throw new Error('parsedMarkdown is required');

  const embeddingParam = embedding
    ? (Array.isArray(embedding) ? JSON.stringify(embedding) : embedding)
    : null;

  const r = await query(
    `INSERT INTO engagements.proposals
       (engagement_id, title, kind, source_type, source_uri,
        raw_content, parsed_markdown, embedding, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
     RETURNING *`,
    [
      engagementId,
      title || null,
      kind,
      sourceType,
      sourceUri || null,
      rawContent || parsedMarkdown,
      parsedMarkdown,
      embeddingParam,
      createdBy || null,
    ]
  ).catch(async (err) => {
    // PGlite fallback: embedding column is JSONB, not vector. Retry without cast.
    if (/type "vector"|cannot cast|column "embedding"/i.test(err.message)) {
      return query(
        `INSERT INTO engagements.proposals
           (engagement_id, title, kind, source_type, source_uri,
            raw_content, parsed_markdown, embedding, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING *`,
        [
          engagementId,
          title || null,
          kind,
          sourceType,
          sourceUri || null,
          rawContent || parsedMarkdown,
          parsedMarkdown,
          embeddingParam,
          createdBy || null,
        ]
      );
    }
    throw err;
  });
  return r.rows[0];
}

/**
 * Hard-delete a proposal. Scoped to engagement_id so a route param mismatch
 * (or a stale UI state) can't blow away a row from a different engagement.
 * Returns the deleted row, or null if no match.
 */
export async function deleteProposal({ engagementId, proposalId }) {
  const r = await query(
    `DELETE FROM engagements.proposals
      WHERE id = $1 AND engagement_id = $2
      RETURNING id, title`,
    [proposalId, engagementId]
  );
  return r.rows[0] || null;
}

export async function listProposals(engagementId) {
  const r = await query(
    `SELECT id, engagement_id, title, kind, source_type, source_uri,
            parsed_markdown, created_by, created_at
       FROM engagements.proposals
      WHERE engagement_id = $1
      ORDER BY created_at ASC`,
    [engagementId]
  );
  return r.rows;
}

// ============================================================
// specs + sections
// ============================================================

export async function ensureSpec(engagementId) {
  const existing = await query(
    `SELECT * FROM engagements.specs WHERE engagement_id = $1`,
    [engagementId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const r = await query(
    `INSERT INTO engagements.specs (engagement_id)
     VALUES ($1)
     ON CONFLICT (engagement_id) DO UPDATE SET engagement_id = EXCLUDED.engagement_id
     RETURNING *`,
    [engagementId]
  );
  return r.rows[0];
}

export async function getSpecByEngagement(engagementId) {
  const r = await query(
    `SELECT * FROM engagements.specs WHERE engagement_id = $1`,
    [engagementId]
  );
  return r.rows[0] || null;
}

export async function listSections(specId) {
  const r = await query(
    `SELECT * FROM engagements.spec_sections
      WHERE spec_id = $1
      ORDER BY ordinal ASC`,
    [specId]
  );
  return r.rows;
}

export async function getSection(sectionId) {
  const r = await query(
    `SELECT * FROM engagements.spec_sections WHERE id = $1`,
    [sectionId]
  );
  return r.rows[0] || null;
}

/**
 * Save a human edit to a section.
 *
 * Reads current body inside the same transaction, writes the audit row, then
 * updates the section. Pinned sections still accept human edits (only the
 * synth pipeline respects pins).
 *
 * @returns {{ section, edit }} updated section and the audit row created
 */
export async function saveSectionEdit({ sectionId, newBody, actor }) {
  if (!actor) throw new Error('actor is required');
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM engagements.spec_sections WHERE id = $1 FOR UPDATE`,
      [sectionId]
    );
    const section = cur.rows[0];
    if (!section) throw new Error(`section not found: ${sectionId}`);

    if (section.body === newBody) {
      return { section, edit: null };
    }

    const edit = await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind, before, after)
       VALUES ($1, $2, $3, 'edit', $4, $5)
       RETURNING *`,
      [section.spec_id, section.id, actor, section.body, newBody]
    );

    const updated = await client.query(
      `UPDATE engagements.spec_sections
          SET body = $2,
              last_human_edit_at = now(),
              last_human_edit_by = $3
        WHERE id = $1
        RETURNING *`,
      [sectionId, newBody, actor]
    );

    return { section: updated.rows[0], edit: edit.rows[0] };
  });
}

/**
 * Add a new section to a spec. Defaults to pinned so synth doesn't
 * immediately rewrite or remove explicit human intent. Inserts at the end
 * of the current ordering; caller can reorder with reorderSection().
 */
export async function addSection({ specId, sectionKey, title, body = '', isCore = false, actor, pinByDefault = true }) {
  if (!actor) throw new Error('actor is required');
  if (!sectionKey || !title) throw new Error('sectionKey and title are required');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(sectionKey)) {
    throw new Error('sectionKey must be lowercase alphanumeric / underscore / hyphen');
  }

  return withTransaction(async (client) => {
    const ordR = await client.query(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ord
         FROM engagements.spec_sections WHERE spec_id = $1`,
      [specId]
    );
    const ordinal = ordR.rows[0].next_ord;

    // Handle section_key collisions by appending a numeric suffix
    // (foo, foo_2, foo_3, …) so the (spec_id, section_key) UNIQUE never
    // blows up on the caller. Caller's chosen key is preserved when free.
    let resolvedKey = sectionKey;
    let suffix = 1;
    // Loop with bound; in practice we exit on the first or second try.
    for (let i = 0; i < 50; i++) {
      const collision = await client.query(
        `SELECT 1 FROM engagements.spec_sections WHERE spec_id = $1 AND section_key = $2 LIMIT 1`,
        [specId, resolvedKey]
      );
      if (collision.rows.length === 0) break;
      suffix++;
      resolvedKey = `${sectionKey}_${suffix}`;
    }

    const ins = await client.query(
      `INSERT INTO engagements.spec_sections
         (spec_id, section_key, title, body, ordinal, is_core, pin_state,
          last_human_edit_at, last_human_edit_by, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, '[]'::jsonb)
       RETURNING *`,
      [specId, resolvedKey, title, body, ordinal, isCore, pinByDefault ? 'pinned' : 'unpinned', actor]
    );
    const section = ins.rows[0];

    await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind, after, note)
       VALUES ($1, $2, $3, 'section_add', $4, $5)`,
      [specId, section.id, actor, body, `manually added; auto-${pinByDefault ? 'pinned' : 'unpinned'}`]
    );
    return section;
  });
}

/**
 * Remove a section. Returns the deleted row or null if not found.
 */
export async function deleteSection({ sectionId, actor }) {
  if (!actor) throw new Error('actor is required');
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM engagements.spec_sections WHERE id = $1`,
      [sectionId]
    );
    const section = cur.rows[0];
    if (!section) return null;

    await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind, before, note)
       VALUES ($1, $2, $3, 'section_remove', $4, 'manually deleted')`,
      [section.spec_id, section.id, actor, section.body]
    );
    await client.query(
      `DELETE FROM engagements.spec_sections WHERE id = $1`,
      [sectionId]
    );
    return section;
  });
}

/**
 * Reorder a section up or down by one position. Swaps ordinals with the
 * neighbor. No-op if already at the boundary.
 */
export async function reorderSection({ sectionId, direction, actor }) {
  if (!actor) throw new Error('actor is required');
  if (!['up', 'down'].includes(direction)) {
    throw new Error('direction must be "up" or "down"');
  }
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM engagements.spec_sections WHERE id = $1 FOR UPDATE`,
      [sectionId]
    );
    const section = cur.rows[0];
    if (!section) return { section: null, swapped: false };

    const op = direction === 'up' ? '<' : '>';
    const order = direction === 'up' ? 'DESC' : 'ASC';
    const neighbor = await client.query(
      `SELECT * FROM engagements.spec_sections
        WHERE spec_id = $1 AND ordinal ${op} $2
        ORDER BY ordinal ${order}
        LIMIT 1
        FOR UPDATE`,
      [section.spec_id, section.ordinal]
    );
    if (!neighbor.rows[0]) return { section, swapped: false };
    const n = neighbor.rows[0];

    // Two-step ordinal swap to avoid the (spec_id, section_key) uniqueness
    // tripping us up — section_key doesn't change, only ordinal, but be safe.
    await client.query(
      `UPDATE engagements.spec_sections SET ordinal = -1 WHERE id = $1`,
      [section.id]
    );
    await client.query(
      `UPDATE engagements.spec_sections SET ordinal = $1 WHERE id = $2`,
      [section.ordinal, n.id]
    );
    await client.query(
      `UPDATE engagements.spec_sections SET ordinal = $1 WHERE id = $2`,
      [n.ordinal, section.id]
    );

    await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind, note)
       VALUES ($1, $2, $3, 'section_reorder', $4)`,
      [section.spec_id, section.id, actor, `moved ${direction} (was ordinal ${section.ordinal}, now ${n.ordinal})`]
    );
    return { section: { ...section, ordinal: n.ordinal }, swapped: true };
  });
}

export async function setSectionPin({ sectionId, pinState, actor }) {
  if (!PIN_STATES.has(pinState)) throw new Error(`invalid pin_state: ${pinState}`);
  if (!actor) throw new Error('actor is required');

  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM engagements.spec_sections WHERE id = $1 FOR UPDATE`,
      [sectionId]
    );
    const section = cur.rows[0];
    if (!section) throw new Error(`section not found: ${sectionId}`);
    if (section.pin_state === pinState) return { section, edit: null };

    const edit = await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [section.spec_id, section.id, actor, pinState === 'pinned' ? 'pin' : 'unpin']
    );

    const updated = await client.query(
      `UPDATE engagements.spec_sections SET pin_state = $2 WHERE id = $1 RETURNING *`,
      [sectionId, pinState]
    );

    return { section: updated.rows[0], edit: edit.rows[0] };
  });
}

// ============================================================
// generated_proposals (#3) — persistent history of generated proposals
// ============================================================

export async function recordGeneratedProposal({
  engagementId, specVersion, mode, format, markdown,
  gdocUrl = null, gdocId = null, costUsd = null, modelKey = null, generatedBy,
}) {
  if (!engagementId) throw new Error('engagementId is required');
  if (!['generic-template', 'tailored-client'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
  if (!['md', 'docx', 'gdoc'].includes(format)) throw new Error(`invalid format: ${format}`);
  if (!generatedBy) throw new Error('generatedBy is required');
  return withTransaction(async (client) => {
    // Fetch the owning org so the artifact consumer can stamp tenancy without
    // a second round-trip. Done inside the txn so row + notify are atomic.
    const engRow = await client.query(
      `SELECT owner_org_id, name FROM engagements.engagements WHERE id = $1`,
      [engagementId]
    );
    const ownerOrgId = engRow.rows[0]?.owner_org_id ?? null;
    const r = await client.query(
      `INSERT INTO engagements.generated_proposals
         (engagement_id, spec_version, mode, format, markdown, gdoc_url, gdoc_id, cost_usd, model_key, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [engagementId, specVersion, mode, format, markdown, gdocUrl, gdocId, costUsd, modelKey, generatedBy]
    );
    const row = r.rows[0];
    // OPT-99: fire-and-forget notify — decouples generation from the artifact
    // stack (no import of lib/content/*; CG-1 clean). The consumer in
    // generated-artifact-worker.js re-fetches the markdown and calls createArtifact.
    if (ownerOrgId) {
      const payload = JSON.stringify({ id: row.id, kind: 'proposal', owner_org_id: ownerOrgId });
      await client.query(`SELECT pg_notify('artifact_register', $1)`, [payload]);
    }
    return row;
  });
}

export async function listGeneratedProposals(engagementId, { limit = 50 } = {}) {
  const r = await query(
    `SELECT id, engagement_id, spec_version, mode, format, gdoc_url, gdoc_id,
            cost_usd, model_key, generated_by, created_at,
            approved_at, approved_by,
            length(markdown) AS markdown_length
       FROM engagements.generated_proposals
      WHERE engagement_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [engagementId, limit]
  );
  return r.rows;
}

export async function getGeneratedProposal(id) {
  const r = await query(
    `SELECT * FROM engagements.generated_proposals WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

export async function deleteGeneratedProposal(id) {
  const r = await query(
    `DELETE FROM engagements.generated_proposals WHERE id = $1 RETURNING id`,
    [id]
  );
  return r.rows[0] || null;
}

/**
 * Mark a generated proposal as approved. Auto-unapproves any prior approved
 * tailored-client row on the same engagement (the partial unique index
 * enforces one-approved-at-a-time; we clear before stamping so the index
 * never trips). Writes audit rows to engagements.spec_edits with
 * section_id = NULL.
 *
 * Throws if the proposal is a 'generic-template' (those aren't committed
 * to-client artifacts and don't drive contract drafting).
 */
export async function approveGeneratedProposal({ id, actor }) {
  if (!id) throw new Error('id is required');
  if (!actor) throw new Error('actor is required');

  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT id, engagement_id, mode, approved_at FROM engagements.generated_proposals
        WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const gp = cur.rows[0];
    if (!gp) throw new Error('generated proposal not found');
    if (gp.mode !== 'tailored-client') {
      throw new Error(`cannot approve a ${gp.mode} proposal — only tailored-client is contract-eligible`);
    }

    // Pull the engagement's spec so audit rows have a spec_id (NOT NULL FK).
    const specRow = await client.query(
      `SELECT id FROM engagements.specs WHERE engagement_id = $1`,
      [gp.engagement_id]
    );
    const specId = specRow.rows[0]?.id || null;

    // Clear any previously approved tailored row on this engagement and
    // audit each unapproval.
    const prior = await client.query(
      `SELECT id FROM engagements.generated_proposals
        WHERE engagement_id = $1
          AND mode = 'tailored-client'
          AND approved_at IS NOT NULL
          AND id <> $2
        FOR UPDATE`,
      [gp.engagement_id, id]
    );
    for (const row of prior.rows) {
      await client.query(
        `UPDATE engagements.generated_proposals
            SET approved_at = NULL, approved_by = NULL
          WHERE id = $1`,
        [row.id]
      );
      if (specId) {
        await client.query(
          `INSERT INTO engagements.spec_edits
             (spec_id, section_id, actor, change_kind, note)
           VALUES ($1, NULL, $2, 'proposal_unapproved', $3)`,
          [specId, actor, `superseded by ${id}`]
        );
      }
    }

    if (gp.approved_at) {
      // Already approved — idempotent return.
      const cur2 = await client.query(
        `SELECT * FROM engagements.generated_proposals WHERE id = $1`,
        [id]
      );
      return cur2.rows[0];
    }

    const updated = await client.query(
      `UPDATE engagements.generated_proposals
          SET approved_at = now(),
              approved_by = $2
        WHERE id = $1
        RETURNING *`,
      [id, actor]
    );

    if (specId) {
      await client.query(
        `INSERT INTO engagements.spec_edits
           (spec_id, section_id, actor, change_kind, note)
         VALUES ($1, NULL, $2, 'proposal_approved', $3)`,
        [specId, actor, `generated_proposal:${id}`]
      );
    }

    return updated.rows[0];
  });
}

export async function unapproveGeneratedProposal({ id, actor }) {
  if (!id) throw new Error('id is required');
  if (!actor) throw new Error('actor is required');

  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT id, engagement_id, approved_at FROM engagements.generated_proposals
        WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const gp = cur.rows[0];
    if (!gp) throw new Error('generated proposal not found');
    if (!gp.approved_at) return gp; // idempotent

    const specRow = await client.query(
      `SELECT id FROM engagements.specs WHERE engagement_id = $1`,
      [gp.engagement_id]
    );
    const specId = specRow.rows[0]?.id || null;

    const updated = await client.query(
      `UPDATE engagements.generated_proposals
          SET approved_at = NULL, approved_by = NULL
        WHERE id = $1
        RETURNING *`,
      [id]
    );

    if (specId) {
      await client.query(
        `INSERT INTO engagements.spec_edits
           (spec_id, section_id, actor, change_kind, note)
         VALUES ($1, NULL, $2, 'proposal_unapproved', $3)`,
        [specId, actor, `generated_proposal:${id}`]
      );
    }

    return updated.rows[0];
  });
}

/**
 * Returns the currently approved tailored proposal for an engagement, or null.
 */
export async function getApprovedGeneratedProposal(engagementId) {
  const r = await query(
    `SELECT * FROM engagements.generated_proposals
      WHERE engagement_id = $1
        AND mode = 'tailored-client'
        AND approved_at IS NOT NULL
      LIMIT 1`,
    [engagementId]
  );
  return r.rows[0] || null;
}

// ============================================================
// audit + conflicts
// ============================================================

export async function listEdits(specId, { limit = 100, sectionId = null } = {}) {
  const params = [specId];
  let where = `spec_id = $1`;
  if (sectionId) {
    params.push(sectionId);
    where += ` AND section_id = $${params.length}`;
  }
  params.push(limit);
  const r = await query(
    `SELECT * FROM engagements.spec_edits
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

// ============================================================
// client domain memory (#12) — remember which domains turned out to
// belong to which client name on past auto-builds.
// ============================================================

export async function getClientDomainMemory(clientName) {
  const r = await query(
    `SELECT domain, source, confirmed_at, hit_count
       FROM engagements.client_domain_memory
      WHERE client_name_lc = $1
      ORDER BY hit_count DESC, confirmed_at DESC`,
    [String(clientName || '').toLowerCase().trim()]
  );
  return r.rows;
}

export async function rememberClientDomains(clientName, domains, source = 'auto-build') {
  if (!clientName || !Array.isArray(domains) || !domains.length) return 0;
  const key = String(clientName).toLowerCase().trim();
  if (!key) return 0;
  let inserted = 0;
  for (const d of domains) {
    const domain = String(d).toLowerCase().trim();
    if (!domain) continue;
    await query(
      `INSERT INTO engagements.client_domain_memory (client_name_lc, domain, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_name_lc, domain) DO UPDATE
         SET hit_count = engagements.client_domain_memory.hit_count + 1,
             confirmed_at = now()`,
      [key, domain, source]
    );
    inserted++;
  }
  return inserted;
}

// ============================================================
// section change proposals (synth-queued add/remove)
// ============================================================

export async function queueSectionChangeProposal({ specId, kind, payload, summary, rationale, sectionId = null, proposedBy = 'synth', client = null }) {
  if (!['add', 'remove'].includes(kind)) throw new Error(`invalid kind: ${kind}`);
  const q = client?.query ? client.query.bind(client) : query;
  const r = await q(
    `INSERT INTO engagements.section_change_proposals
       (spec_id, section_id, kind, payload, summary, rationale, proposed_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [specId, sectionId, kind, JSON.stringify(payload), summary, rationale || null, proposedBy]
  );
  return r.rows[0];
}

export async function listPendingSectionProposals(specId) {
  const r = await query(
    `SELECT * FROM engagements.section_change_proposals
      WHERE spec_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [specId]
  );
  return r.rows;
}

export async function getSectionProposal(proposalId) {
  const r = await query(
    `SELECT * FROM engagements.section_change_proposals WHERE id = $1`,
    [proposalId]
  );
  return r.rows[0] || null;
}

/**
 * Accept a pending section change proposal. For 'add' proposals, inserts
 * the new section. For 'remove', deletes the referenced section. Audits
 * via spec_edits.
 */
export async function acceptSectionProposal({ proposalId, actor }) {
  if (!actor) throw new Error('actor is required');
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM engagements.section_change_proposals
        WHERE id = $1 AND status = 'pending'
        FOR UPDATE`,
      [proposalId]
    );
    const p = cur.rows[0];
    if (!p) return null;

    let resultingSection = null;

    if (p.kind === 'add') {
      const payload = p.payload;
      const ordR = await client.query(
        `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ord
           FROM engagements.spec_sections WHERE spec_id = $1`,
        [p.spec_id]
      );
      // Always append to the end rather than honoring synth's proposed
      // ordinal; otherwise two accepts can collide at the same slot.
      const ordinal = ordR.rows[0].next_ord;
      const ins = await client.query(
        `INSERT INTO engagements.spec_sections
           (spec_id, section_key, title, body, ordinal, is_core, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (spec_id, section_key) DO UPDATE
           SET title = EXCLUDED.title, body = EXCLUDED.body, ordinal = EXCLUDED.ordinal
         RETURNING *`,
        [
          p.spec_id,
          payload.section_key,
          payload.title,
          payload.body || '',
          ordinal,
          !!payload.is_core,
          JSON.stringify(payload.provenance || []),
        ]
      );
      resultingSection = ins.rows[0];

      await client.query(
        `INSERT INTO engagements.spec_edits
           (spec_id, section_id, actor, change_kind, after, note)
         VALUES ($1, $2, $3, 'section_add', $4, $5)`,
        [p.spec_id, resultingSection.id, actor, payload.body || '', `accepted synth proposal: ${p.summary}`]
      );
    } else {
      // remove
      if (p.section_id) {
        const cur2 = await client.query(
          `SELECT * FROM engagements.spec_sections WHERE id = $1`,
          [p.section_id]
        );
        const sec = cur2.rows[0];
        if (sec) {
          await client.query(
            `INSERT INTO engagements.spec_edits
               (spec_id, section_id, actor, change_kind, before, note)
             VALUES ($1, $2, $3, 'section_remove', $4, $5)`,
            [p.spec_id, sec.id, actor, sec.body, `accepted synth proposal: ${p.summary}`]
          );
          await client.query(
            `DELETE FROM engagements.spec_sections WHERE id = $1`,
            [p.section_id]
          );
        }
      }
    }

    await client.query(
      `UPDATE engagements.section_change_proposals
          SET status = 'accepted', resolved_by = $2, resolved_at = now()
        WHERE id = $1`,
      [proposalId, actor]
    );
    await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind, note)
       VALUES ($1, $2, $3, 'section_proposal_accept', $4)`,
      [p.spec_id, resultingSection?.id || p.section_id || null, actor, p.summary]
    );

    return { proposal: { ...p, status: 'accepted' }, section: resultingSection };
  });
}

/**
 * Bulk-accept or bulk-reject every pending section proposal on a spec.
 * Returns counts of what happened.
 */
export async function bulkResolveSectionProposals({ specId, action, actor }) {
  if (!actor) throw new Error('actor is required');
  if (!['accept', 'reject'].includes(action)) throw new Error(`invalid action: ${action}`);
  const pending = await listPendingSectionProposals(specId);
  let accepted = 0;
  let rejected = 0;
  for (const p of pending) {
    if (action === 'accept') {
      const r = await acceptSectionProposal({ proposalId: p.id, actor });
      if (r) accepted++;
    } else {
      const r = await rejectSectionProposal({ proposalId: p.id, actor });
      if (r) rejected++;
    }
  }
  return { accepted, rejected, total: pending.length };
}

/**
 * Merge proposals from one engagement into another. Source engagement's
 * proposals are reassigned to the target. Source engagement is then
 * deleted (cascade removes its spec / sections / etc.). Returns counts.
 */
export async function mergeEngagement({ sourceId, targetId, actor }) {
  if (!actor) throw new Error('actor is required');
  if (sourceId === targetId) throw new Error('cannot merge into self');
  return withTransaction(async (client) => {
    const sourceR = await client.query(`SELECT * FROM engagements.engagements WHERE id = $1`, [sourceId]);
    const targetR = await client.query(`SELECT * FROM engagements.engagements WHERE id = $1`, [targetId]);
    const source = sourceR.rows[0];
    const target = targetR.rows[0];
    if (!source) throw new Error('source engagement not found');
    if (!target) throw new Error('target engagement not found');
    if (source.is_master || target.is_master) throw new Error('cannot merge master engagement');

    const moved = await client.query(
      `UPDATE engagements.proposals SET engagement_id = $1 WHERE engagement_id = $2 RETURNING id`,
      [targetId, sourceId]
    );
    await client.query(`DELETE FROM engagements.engagements WHERE id = $1`, [sourceId]);
    return {
      proposals_moved: moved.rowCount || moved.rows.length,
      source: { id: source.id, name: source.name },
      target: { id: target.id, name: target.name },
    };
  });
}

export async function rejectSectionProposal({ proposalId, actor }) {
  if (!actor) throw new Error('actor is required');
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM engagements.section_change_proposals
        WHERE id = $1 AND status = 'pending'
        FOR UPDATE`,
      [proposalId]
    );
    const p = cur.rows[0];
    if (!p) return null;

    await client.query(
      `UPDATE engagements.section_change_proposals
          SET status = 'rejected', resolved_by = $2, resolved_at = now()
        WHERE id = $1`,
      [proposalId, actor]
    );
    await client.query(
      `INSERT INTO engagements.spec_edits
         (spec_id, section_id, actor, change_kind, note)
       VALUES ($1, $2, $3, 'section_proposal_reject', $4)`,
      [p.spec_id, p.section_id, actor, p.summary]
    );
    return { ...p, status: 'rejected' };
  });
}

export async function listOpenConflicts(specId) {
  const r = await query(
    `SELECT * FROM engagements.spec_conflicts
      WHERE spec_id = $1 AND status = 'open'
      ORDER BY created_at ASC`,
    [specId]
  );
  return r.rows;
}

export async function resolveConflict({ conflictId, resolution, actor }) {
  if (!actor) throw new Error('actor is required');
  const r = await query(
    `UPDATE engagements.spec_conflicts
        SET status = 'resolved',
            resolution = $2::jsonb,
            resolved_by = $3,
            resolved_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [conflictId, JSON.stringify(resolution || {}), actor]
  );
  return r.rows[0] || null;
}

export async function dismissConflict({ conflictId, actor }) {
  if (!actor) throw new Error('actor is required');
  const r = await query(
    `UPDATE engagements.spec_conflicts
        SET status = 'dismissed',
            resolved_by = $2,
            resolved_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [conflictId, actor]
  );
  return r.rows[0] || null;
}

// ============================================================
// composite read (used by GET /api/engagements/[id])
// ============================================================

export async function getEngagementDetail(id, { principal } = {}) {
  // STAQPRO-618: the org-scope gate is the getEngagement read — if the principal
  // can't see this engagement it returns null and we never load its children.
  const engagement = await getEngagement(id, { principal });
  if (!engagement) return null;
  const spec = await ensureSpec(id);
  const [proposals, sections, conflicts, sectionProposals, master, childSpecCount] = await Promise.all([
    listProposals(id),
    listSections(spec.id),
    listOpenConflicts(spec.id),
    listPendingSectionProposals(spec.id),
    // Only resolve master id for non-master engagements (avoid self-link).
    engagement.is_master ? Promise.resolve(null) : getMasterEngagement(),
    // For the master, the UI needs to know how many child engagements
    // already have synthesized specs — they count as valid input for
    // distillation even without manual proposals attached.
    engagement.is_master ? countChildEngagementSpecs() : Promise.resolve(0),
  ]);
  return {
    engagement,
    spec,
    proposals,
    sections,
    conflicts,
    sectionProposals,
    masterId: master?.id || null,
    childSpecCount,
  };
}

async function countChildEngagementSpecs() {
  const r = await query(
    `SELECT count(*)::int AS n
       FROM engagements.engagements e
       JOIN engagements.specs s ON s.engagement_id = e.id
      WHERE e.is_master = false
        AND EXISTS (SELECT 1 FROM engagements.spec_sections ss WHERE ss.spec_id = s.id)`
  );
  return r.rows[0]?.n || 0;
}
