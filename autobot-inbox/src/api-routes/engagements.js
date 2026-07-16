// Force Railway redeploy on the autobot-inbox service — chunks 1-4
// of the engagements audit pass appear to have skipped the deploy
// during the Railway incident (status.railway.com/incident/I23M92U0).

/**
 * Engagements API routes — client project scoping → living spec.
 *
 * The board UI proxies to these routes. All persistence lives in
 * lib/engagements/db.js; ingest in lib/engagements/ingest.js; synth in
 * lib/engagements/synth.js. This file is thin HTTP glue.
 *
 *   POST   /api/engagements                                — create
 *   GET    /api/engagements                                — list
 *   GET    /api/engagements/:id                            — detail
 *   PATCH  /api/engagements/:id                            — update status
 *   POST   /api/engagements/:id/proposals                  — ingest paste/upload/url
 *   PATCH  /api/engagements/:id/sections/:sid              — edit body OR set pin
 *   POST   /api/engagements/:id/synthesize                 — re-synth (manual)
 *   POST   /api/engagements/:id/conflicts/:cid/resolve     — resolve conflict
 */

import {
  createEngagement,
  listEngagements,
  getEngagementDetail,
  updateEngagementStatus,
  deleteEngagement,
  saveSectionEdit,
  setSectionPin,
  getSection,
  ensureSpec,
  addSection,
  deleteSection,
  reorderSection,
  acceptSectionProposal,
  rejectSectionProposal,
  resolveConflict,
  dismissConflict,
  deleteProposal,
  recordGeneratedProposal,
  listGeneratedProposals,
  getGeneratedProposal,
  deleteGeneratedProposal,
  approveGeneratedProposal,
  unapproveGeneratedProposal,
  bulkResolveSectionProposals,
  mergeEngagement,
  listEdits,
  getSpecByEngagement,
  setEngagementAsyncStatus,
  clearEngagementAsyncStatus,
  SYSTEM_PRINCIPAL,
} from '../../../lib/engagements/db.js';
import { resolveOnBehalfOfOrg } from '../../../lib/engagements/on-behalf-of.js';
import { ingestPaste, ingestUpload, ingestUrl } from '../../../lib/engagements/ingest.js';
import { synthesizeEngagementSpec } from '../../../lib/engagements/synth.js';
import { exportSpecAsMarkdown, specFilenameBase, loadSpecForExport, renderSpecAsMarkdown } from '../../../lib/engagements/exporter.js';
import { renderEngagementSpecDocx } from '../../../lib/engagements/docx-export.js';
import { exportSpecToGoogleDoc } from '../../../lib/engagements/gdoc-export.js';
import { generateProposalTemplate, generateTailoredProposal } from '../../../lib/engagements/proposal-template.js';
import { listProposals as listProposalsForEng } from '../../../lib/engagements/db.js';
import { expandClientName, findClientCandidates } from '../../../lib/engagements/client-search.js';
import { autoBuildEngagement } from '../../../lib/engagements/auto-build.js';
import {
  draftContractFromApprovedProposal,
  getLatestContractForEngagement,
} from '../../../lib/engagements/contract-drafter.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// STAQPRO-618 (ADR-015): 'advisory' kind + 7-state deal lifecycle.
const VALID_KINDS = new Set(['website', 'mobile_app', 'api', 'other', 'advisory']);
const VALID_STATUSES = new Set([
  'prospect', 'proposed', 'won', 'active', 'closed', 'lost', 'archived',
]);
const VALID_PROPOSAL_KINDS = new Set(['draft', 'finalized', 'note']);
// STAQPRO-618 (Linus): a freshly-created engagement may only START at 'prospect'
// (default) or 'active' (ADR-015 create-as-active, no proposal required). Advancing
// to 'proposed'/'won'/'closed'/'lost' is a lifecycle transition via PATCH, never a
// create — otherwise a client could POST {status:'won'} and skip the whole funnel.
const CREATE_STATUSES = new Set(['prospect', 'active']);
// STAQPRO-618: ownership is ALWAYS derived from the verified principal, NEVER
// from the request body. A client that tries to set its own org is rejected.
const OWNERSHIP_BODY_KEYS = ['owner_org_id', 'owner_scope', 'owner_user_id'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function pathParts(req) {
  return new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
}

function pickActor(req) {
  // Mirrors contracts.js — board sends x-board-user header through the proxy.
  return (req.headers?.['x-board-user'] || req.headers?.['x-user-email'] || 'unknown').toString();
}

export function registerEngagementsRoutes(routes, { withViewer } = {}) {
  // STAQPRO-618: resolve the tenancy principal for scoped reads + owner-stamped
  // writes. withViewer is injected by api.js (mirrors campaigns.js). Absent (unit
  // test) or on throw → null; the fail-closed read path then returns nothing and
  // the write path falls the INSERT through to the column DEFAULT (single-org).
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // ---------- AUTO-BUILD FROM CLIENT (knowledge-base integration) ----------

  routes.set('POST /api/engagements/client-search', async (req, body) => {
    const clientName = (body?.client_name || '').toString().trim();
    if (!clientName) throw badRequest('client_name is required');

    const expanded = body?.expanded || null;
    const since = body?.since || null;
    const until = body?.until || null;
    try {
      const result = expanded
        ? await findClientCandidates(clientName, { expanded, since, until })
        : await findClientCandidates(clientName, { since, until });
      return result;
    } catch (err) {
      if (/required|empty/i.test(err.message)) err.statusCode = 400;
      throw err;
    }
  });

  routes.set('POST /api/engagements/expand-client', async (req, body) => {
    // Convenience endpoint when the UI wants to show the expansion to the
    // user BEFORE the retrieval queries run (cheapest possible roundtrip).
    const clientName = (body?.client_name || '').toString().trim();
    if (!clientName) throw badRequest('client_name is required');
    const out = await expandClientName(clientName);
    return out;
  });

  routes.set('POST /api/engagements/auto-build', async (req, body) => {
    const clientName = (body?.client_name || '').toString().trim();
    if (!clientName) throw badRequest('client_name is required');
    const selections = body?.selections || {};
    const actor = pickActor(req);

    // Validate selections + existing engagement synchronously so caller gets
    // a quick error if obviously misconfigured. The actual ingest + synth
    // run asynchronously after the response goes out because they routinely
    // exceed Cloudflare's 100s request ceiling.
    const totalSelected =
      (selections.calendar_ids || []).length +
      (selections.transcript_ids || []).length +
      (selections.message_ids || []).length +
      (selections.signal_ids || []).length;
    if (totalSelected === 0) {
      throw badRequest('No source items selected — pick at least one meeting, transcript, email, or signal.');
    }

    // STAQPRO-618: scope the existence check to the caller so you can only append
    // sources to an engagement you can see.
    const principal = await resolvePrincipalFor(req);

    // If we're appending, validate the engagement exists synchronously.
    if (body?.existing_engagement_id) {
      const { getEngagement } = await import('../../../lib/engagements/db.js');
      const existing = await getEngagement(body.existing_engagement_id, { principal });
      if (!existing) throw badRequest(`existing engagement not found: ${body.existing_engagement_id}`);
      if (existing.is_master) throw badRequest('Cannot ingest sources into the master engagement.');
    }

    // Create engagement synchronously when this is a new build, so the
    // client has a real engagement_id to navigate to immediately.
    let engagementId = body?.existing_engagement_id || null;
    let isNew = !engagementId;
    if (!engagementId) {
      // OPT-5: honor an explicit on_behalf_of_org_id authoring-org override here
      // too, falling back to the writer's org. resolveOnBehalfOfOrg throws 403 if
      // the writer isn't a member of the requested override org.
      let ownerOrgId;
      try {
        ownerOrgId = resolveOnBehalfOfOrg({ explicitOrgId: body?.on_behalf_of_org_id, principal });
      } catch (err) {
        if (!err.statusCode) err.statusCode = 403;
        throw err;
      }
      const { createEngagement } = await import('../../../lib/engagements/db.js');
      const created = await createEngagement({
        ownerOrgId,
        name: (body?.engagement_name || '').trim() || `Proposal for ${clientName}`,
        client: clientName,
        kind: 'other',
        createdBy: actor,
      });
      engagementId = created.id;
    }

    // Fire-and-forget the heavy lifting. Errors are logged but don't fail
    // the HTTP request (the client has already gotten the engagement_id).
    Promise.resolve().then(async () => {
      try {
        await autoBuildEngagement({
          clientName,
          engagementName: body?.engagement_name,
          selections,
          actor,
          existingEngagementId: engagementId,
          confirmedDomains: Array.isArray(body?.confirmed_domains) ? body.confirmed_domains : [],
        });
      } catch (err) {
        console.error(`[auto-build async] failed for engagement ${engagementId}: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }
    });

    return {
      engagement_id: engagementId,
      is_new: isNew,
      status: 'building',
      message: 'Auto-build started. Ingestion and synth are running in the background — open the engagement page to watch proposals and sections appear (~30-90s typical).',
    };
  });

  // ---------- LIST + CREATE ----------

  routes.set('GET /api/engagements', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status') || undefined;
    if (status && !VALID_STATUSES.has(status)) {
      throw badRequest(`status must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }
    // STAQPRO-618: org-scope the list against the caller's principal (fail-closed).
    const principal = await resolvePrincipalFor(req);
    const engagements = await listEngagements({ status, principal });
    return { engagements };
  });

  routes.set('POST /api/engagements', async (req, body) => {
    const { name, client, kind, status } = body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw badRequest('name is required');
    }
    // STAQPRO-618: ownership is derived from the token, never accepted from the
    // body. Reject any attempt to set it explicitly so a client can't self-assign
    // an org/user (the same class as the 588 cross-tenant leak).
    for (const k of OWNERSHIP_BODY_KEYS) {
      if (body && body[k] !== undefined) {
        throw badRequest(`${k} cannot be set from the request body — ownership is derived from your identity`);
      }
    }
    if (kind && !VALID_KINDS.has(kind)) {
      throw badRequest(`kind must be one of: ${[...VALID_KINDS].join(', ')}`);
    }
    // STAQPRO-618: allow create-as-active (ADR-015) but NOT creating directly into a
    // later lifecycle stage (won/closed/...). Default is 'prospect' when omitted.
    if (status && !CREATE_STATUSES.has(status)) {
      throw badRequest(`status on create must be one of: ${[...CREATE_STATUSES].join(', ')} (advance later via PATCH)`);
    }
    // OPT-5: the authoring ("on behalf of") org. An explicit on_behalf_of_org_id
    // overrides the writer's-org default, but only if the writer is a member of
    // that org (resolveOnBehalfOfOrg throws 403 otherwise). owner_org_id is stamped
    // from the resolved authoring org. Note on_behalf_of_org_id is a *validated
    // selection among orgs you own*, distinct from the raw owner_org_id body key
    // (still rejected above) which would be an unvalidated ownership spoof.
    const principal = await resolvePrincipalFor(req);
    let ownerOrgId;
    try {
      ownerOrgId = resolveOnBehalfOfOrg({ explicitOrgId: body?.on_behalf_of_org_id, principal });
    } catch (err) {
      if (!err.statusCode) err.statusCode = 403;
      throw err;
    }
    const engagement = await createEngagement({
      name: name.trim(),
      client: client?.trim() || null,
      kind: kind || 'other',
      ...(status ? { status } : {}),
      ownerOrgId,
      createdBy: pickActor(req),
    });
    return { engagement };
  });

  // ---------- DETAIL + UPDATE ----------

  routes.set('GET /api/engagements/:id', async (req) => {
    const id = pathParts(req).pop();
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    // STAQPRO-618: org-scope the read — an engagement the caller can't see is a
    // 404, not a leak. null principal → visibleClause FALSE → not found.
    const principal = await resolvePrincipalFor(req);
    const detail = await getEngagementDetail(id, { principal });
    if (!detail) throw notFound('engagement not found');
    // Attach the latest contract (if any) drafted from this engagement so
    // the UI can render contract status without a second roundtrip. Missing
    // is fine — null surfaces as "no contract yet" in ContractDraftPanel.
    let latestContract = null;
    try {
      latestContract = await getLatestContractForEngagement(id);
    } catch (err) {
      // Don't break the engagement detail page if contracts table is
      // unreachable for any reason — log and continue.
      console.warn('[engagements] latest_contract lookup failed:', err.message);
    }
    return { ...detail, latest_contract: latestContract };
  });

  routes.set('DELETE /api/engagements/:id', async (req) => {
    const id = pathParts(req).pop();
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const deleted = await deleteEngagement(id);
    if (!deleted) {
      throw notFound('engagement not found (or it is the master engagement, which cannot be deleted)');
    }
    return { ok: true, deleted: { id: deleted.id, name: deleted.name } };
  });

  routes.set('PATCH /api/engagements/:id', async (req, body) => {
    const id = pathParts(req).pop();
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    if (!body?.status) throw badRequest('only status updates supported (status field required)');
    if (!VALID_STATUSES.has(body.status)) {
      throw badRequest(`status must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }
    const engagement = await updateEngagementStatus(id, body.status);
    if (!engagement) throw notFound('engagement not found');
    return { engagement };
  });

  // ---------- INGEST PROPOSAL ----------

  routes.set('POST /api/engagements/:id/proposals', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/proposals
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');

    const sourceType = body?.source_type;
    if (!sourceType || !['paste', 'upload', 'url'].includes(sourceType)) {
      throw badRequest('source_type must be paste, upload, or url');
    }
    const kind = body?.kind || 'draft';
    if (!VALID_PROPOSAL_KINDS.has(kind)) {
      throw badRequest(`kind must be one of: ${[...VALID_PROPOSAL_KINDS].join(', ')}`);
    }
    const actor = pickActor(req);
    const title = body?.title?.trim() || undefined;

    try {
      let proposal;
      if (sourceType === 'paste') {
        if (!body?.content) throw badRequest('content is required for paste');
        proposal = await ingestPaste({
          engagementId: id,
          content: body.content,
          title,
          kind,
          createdBy: actor,
        });
      } else if (sourceType === 'upload') {
        if (!body?.filename || !body?.content_b64) {
          throw badRequest('filename and content_b64 (base64-encoded bytes) are required for upload');
        }
        proposal = await ingestUpload({
          engagementId: id,
          filename: body.filename,
          contentB64: body.content_b64,
          kind,
          createdBy: actor,
        });
      } else {
        if (!body?.url) throw badRequest('url is required for url ingest');
        proposal = await ingestUrl({
          engagementId: id,
          url: body.url,
          kind,
          createdBy: actor,
        });
      }
      return { proposal };
    } catch (err) {
      const userFacingCodes = new Set([
        'UNSUPPORTED_FILE_TYPE',
        'URL_EMPTY',
        'URL_FETCH_FAILED',
        'PDF_NO_TEXT',
        'PDF_PARSE_FAILED',
        'DOCX_EMPTY',
        'DOCX_PARSE_FAILED',
      ]);
      if (!err.statusCode) {
        err.statusCode = userFacingCodes.has(err.code) ? 400 : 500;
      }
      throw err;
    }
  });

  // ---------- DELETE PROPOSAL ----------

  routes.set('DELETE /api/engagements/:id/proposals/:pid', async (req) => {
    const parts = pathParts(req);
    // .../engagements/:id/proposals/:pid
    const id = parts[parts.length - 3];
    const pid = parts[parts.length - 1];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    if (!UUID_RE.test(pid)) throw badRequest('invalid proposal id');
    const deleted = await deleteProposal({ engagementId: id, proposalId: pid });
    if (!deleted) throw notFound('proposal not found');
    return { ok: true, deleted: { id: deleted.id, title: deleted.title } };
  });

  // ---------- SECTION EDIT / PIN ----------

  routes.set('PATCH /api/engagements/:id/sections/:sid', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/sections/:sid
    const sid = parts[parts.length - 1];
    if (!UUID_RE.test(sid)) throw badRequest('invalid section id');

    const section = await getSection(sid);
    if (!section) throw notFound('section not found');

    const actor = pickActor(req);

    if (typeof body?.body === 'string') {
      const result = await saveSectionEdit({
        sectionId: sid,
        newBody: body.body,
        actor,
      });
      return { section: result.section, edit: result.edit };
    }

    if (body?.pin_state === 'pinned' || body?.pin_state === 'unpinned') {
      const result = await setSectionPin({
        sectionId: sid,
        pinState: body.pin_state,
        actor,
      });
      return { section: result.section, edit: result.edit };
    }

    throw badRequest('PATCH body must include `body` (string) or `pin_state` ("pinned"|"unpinned")');
  });

  // ---------- BULK / AUDIT / MERGE ----------

  routes.set('POST /api/engagements/:id/section-proposals/bulk', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/section-proposals/bulk
    const id = parts[parts.length - 3];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const action = (body?.action || '').toLowerCase();
    if (!['accept', 'reject'].includes(action)) throw badRequest('action must be accept|reject');
    const spec = await getSpecByEngagement(id);
    if (!spec) throw notFound('engagement has no spec');
    const result = await bulkResolveSectionProposals({ specId: spec.id, action, actor: pickActor(req) });
    return result;
  });

  routes.set('GET /api/engagements/:id/audit', async (req) => {
    const parts = pathParts(req);
    // .../engagements/:id/audit
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const url = new URL(req.url, 'http://localhost');
    const sectionId = url.searchParams.get('section_id') || null;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    if (sectionId && !UUID_RE.test(sectionId)) throw badRequest('invalid section_id');
    const spec = await getSpecByEngagement(id);
    if (!spec) throw notFound('engagement has no spec');
    const edits = await listEdits(spec.id, { sectionId, limit: Math.min(500, limit) });
    return { edits };
  });

  routes.set('POST /api/engagements/:id/merge', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/merge — target engagement; body { source_id }
    const targetId = parts[parts.length - 2];
    if (!UUID_RE.test(targetId)) throw badRequest('invalid target engagement id');
    const sourceId = body?.source_id;
    if (!sourceId || !UUID_RE.test(sourceId)) throw badRequest('source_id (uuid) required in body');
    try {
      const result = await mergeEngagement({ sourceId, targetId, actor: pickActor(req) });
      return result;
    } catch (err) {
      if (/not found|cannot/i.test(err.message)) err.statusCode = 400;
      throw err;
    }
  });

  // ---------- SECTION CRUD ----------

  routes.set('POST /api/engagements/:id/sections', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/sections
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const title = body?.title?.trim();
    if (!title) throw badRequest('title is required');
    const sectionKey = (body?.section_key || title)
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'section';
    const actor = pickActor(req);

    const spec = await ensureSpec(id);
    const section = await addSection({
      specId: spec.id,
      sectionKey,
      title,
      body: body?.body || '',
      isCore: !!body?.is_core,
      actor,
      pinByDefault: body?.pin_by_default !== false,
    });
    return { section };
  });

  routes.set('DELETE /api/engagements/:id/sections/:sid', async (req) => {
    const parts = pathParts(req);
    const sid = parts[parts.length - 1];
    if (!UUID_RE.test(sid)) throw badRequest('invalid section id');
    const actor = pickActor(req);
    const deleted = await deleteSection({ sectionId: sid, actor });
    if (!deleted) throw notFound('section not found');
    return { ok: true, deleted: { id: deleted.id, title: deleted.title } };
  });

  routes.set('POST /api/engagements/:id/sections/:sid/reorder', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/sections/:sid/reorder
    const sid = parts[parts.length - 2];
    if (!UUID_RE.test(sid)) throw badRequest('invalid section id');
    const direction = (body?.direction || '').toLowerCase();
    if (!['up', 'down'].includes(direction)) {
      throw badRequest('direction must be "up" or "down"');
    }
    const actor = pickActor(req);
    const result = await reorderSection({ sectionId: sid, direction, actor });
    if (!result.section) throw notFound('section not found');
    return result;
  });

  routes.set('POST /api/engagements/:id/section-proposals/:pid', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/section-proposals/:pid
    const pid = parts[parts.length - 1];
    if (!UUID_RE.test(pid)) throw badRequest('invalid proposal id');
    const action = (body?.action || '').toLowerCase();
    if (!['accept', 'reject'].includes(action)) {
      throw badRequest('action must be "accept" or "reject"');
    }
    const actor = pickActor(req);
    const result = action === 'accept'
      ? await acceptSectionProposal({ proposalId: pid, actor })
      : await rejectSectionProposal({ proposalId: pid, actor });
    if (!result) throw notFound('proposal not found or already resolved');
    return result;
  });

  // ---------- SYNTHESIZE ----------

  routes.set('POST /api/engagements/:id/synthesize', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/synthesize
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');

    const actor = pickActor(req);
    const dryRun = !!body?.dry_run;

    // Validate engagement exists + has proposals BEFORE firing. dry_run
    // also stays synchronous (caller wants the preview). STAQPRO-618: scope the
    // existence check to the caller.
    const principal = await resolvePrincipalFor(req);
    const engagement = await (await import('../../../lib/engagements/db.js')).getEngagement(id, { principal });
    if (!engagement) throw notFound('engagement not found');

    if (dryRun) {
      try {
        const result = await synthesizeEngagementSpec(id, { actor, modelKey: body?.model_key, dryRun: true });
        return result;
      } catch (err) {
        if (/no proposals/i.test(err.message)) err.statusCode = 400;
        throw err;
      }
    }

    // Capture spec_id + current version before firing so the client can
    // detect completion via version-bump polling instead of waiting on
    // this HTTP connection (which Cloudflare cuts at 100s).
    const { getSpecByEngagement } = await import('../../../lib/engagements/db.js');
    const specBefore = await getSpecByEngagement(id);
    const versionBefore = specBefore?.version ?? 0;

    Promise.resolve().then(async () => {
      try {
        await synthesizeEngagementSpec(id, { actor, modelKey: body?.model_key });
      } catch (err) {
        console.error(`[synth async] failed for engagement ${id}: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }
    });

    return {
      engagement_id: id,
      spec_id: specBefore?.id || null,
      version_before: versionBefore,
      status: 'synthesizing',
      message: 'Synth started in the background. The page will auto-refresh when sections, conflicts, and the new spec version land (~30-90s typical).',
    };
  });

  // ---------- EXPORT ----------

  routes.set('GET /api/engagements/:id/export.md', async (req) => {
    const parts = pathParts(req);
    // .../engagements/:id/export.md
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const { markdown, engagement, spec } = await exportSpecAsMarkdown(id);
    const filename = `${specFilenameBase(engagement, spec)}.md`;
    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
      body: markdown,
    };
  });

  routes.set('GET /api/engagements/:id/export.docx', async (req) => {
    const parts = pathParts(req);
    // .../engagements/:id/export.docx
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const { markdown, engagement, spec } = await exportSpecAsMarkdown(id);
    // Brand-aware export: same fonts/sizes/colors/logo/footer as contracts.
    // The branded renderer resolves the brand via engagement → counterparty
    // (by client name) → default profile, embeds font weights, and stamps a
    // proper title block + page header/footer.
    const buffer = await renderEngagementSpecDocx({ markdown, engagement, spec });
    const filename = `${specFilenameBase(engagement, spec)}.docx`;
    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
      body: buffer,
    };
  });

  routes.set('POST /api/engagements/:id/export/gdoc', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/export/gdoc
    const id = parts[parts.length - 3];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const actor = pickActor(req);

    // Resolve a workspace email for Google Drive impersonation:
    //   1. explicit user_email in body (testing/override)
    //   2. if actor header is already an email, use it
    //   3. look up the actor (GitHub username) in agent_graph.board_members
    //   4. fall back to GOOGLE_IMPERSONATE_EMAIL env (last-ditch)
    let userEmail = body?.user_email || null;
    if (!userEmail && actor && actor.includes('@')) userEmail = actor;
    if (!userEmail && actor) {
      const { query } = await import('../db.js');
      const r = await query(
        `SELECT email FROM agent_graph.board_members WHERE github_username = $1 LIMIT 1`,
        [actor]
      );
      if (r.rows[0]?.email) userEmail = r.rows[0].email;
    }
    if (!userEmail) userEmail = process.env.GOOGLE_IMPERSONATE_EMAIL || null;
    if (!userEmail) {
      throw badRequest(`Could not resolve a workspace email to impersonate. Actor was "${actor}" — make sure agent_graph.board_members has this user with a non-null email, or set GOOGLE_IMPERSONATE_EMAIL on the server.`);
    }

    const { markdown, engagement, spec } = await exportSpecAsMarkdown(id);
    const title = `${engagement.name} — Spec v${spec.version}`;
    const result = await exportSpecToGoogleDoc({
      markdown,
      title,
      userEmail,
      folderId: body?.folder_id || undefined,
    });
    return { ...result, title, impersonated: userEmail };
  });

  // ---------- GENERATE CLIENT PROPOSAL TEMPLATE (master only) ----------

  routes.set('POST /api/engagements/:id/generate-proposal', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/generate-proposal
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');

    const format = (body?.format || 'md').toLowerCase();
    if (!['md', 'docx', 'gdoc'].includes(format)) {
      throw badRequest(`format must be md, docx, or gdoc — got "${format}"`);
    }

    // Two modes:
    //   - Master engagement: emit a GENERIC proposal template (current
    //     behavior). Brackets everywhere; user fills in per-client.
    //   - Non-master engagement: emit a TAILORED proposal for this specific
    //     client. Pulls master baselines + engagement spec + the engagement's
    //     own ingested proposals (which on auto-built engagements are
    //     meetings/emails/signals from the client), fills brackets with real
    //     values where they exist in the data.
    const { engagement, spec, sections } = await loadSpecForExport(id);

    const mode = engagement.is_master ? 'generic-template' : 'tailored-client';
    const slug = (engagement.client || engagement.name || 'client')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'client';
    const filenameBase = engagement.is_master
      ? `proposal-template-v${spec.version}`
      : `${slug}-proposal-v${spec.version}`;

    // CACHE LOOKUP — if we've already generated this mode at this spec
    // version AND no sections have been edited since, reuse the markdown
    // instead of re-running the LLM. Switching format (.docx ↔ .md ↔ gdoc)
    // for the same spec state becomes free. Bypassed by ?force=1 or
    // body.force = true.
    const force = body?.force === true || new URL(req.url, 'http://localhost').searchParams.get('force') === '1';
    let gen = null;
    let cached = false;
    if (!force) {
      const { query: dbQuery } = await import('../db.js');
      const lastGen = await dbQuery(
        `SELECT id, markdown, cost_usd, model_key, created_at
           FROM engagements.generated_proposals
          WHERE engagement_id = $1 AND mode = $2 AND spec_version = $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [id, mode, spec.version]
      );
      if (lastGen.rows[0]) {
        const sinceEdit = await dbQuery(
          `SELECT 1 FROM engagements.spec_sections
            WHERE spec_id = $1 AND updated_at > $2
            LIMIT 1`,
          [spec.id, lastGen.rows[0].created_at]
        );
        if (sinceEdit.rows.length === 0) {
          gen = {
            markdown: lastGen.rows[0].markdown,
            costUsd: 0,
            modelKey: lastGen.rows[0].model_key,
          };
          cached = true;
        }
      }
    }

    if (!gen) {
      // Stamp async status so the UI shows a banner while the LLM runs.
      try {
        await setEngagementAsyncStatus(id, {
          status: 'generating',
          progress: {
            stage: 'generating',
            label: engagement.is_master
              ? `Generating generic proposal template (.${format})`
              : `Generating tailored proposal for ${engagement.client || engagement.name} (.${format})`,
          },
        });
      } catch { /* non-fatal */ }

      try {
        if (engagement.is_master) {
          const masterMd = renderSpecAsMarkdown({ engagement, spec, sections });
          gen = await generateProposalTemplate(masterMd);
        } else {
          // Cost optimization: drop master from the tailored prompt. The
          // engagement spec ALREADY inherited master baselines into its
          // sections during synth, so sending the master again duplicates
          // context. Sourcing real values continues to come from the
          // touchpoints (where budgets/dates/specifics live).
          const engagementMd = renderSpecAsMarkdown({ engagement, spec, sections });
          const sourceTouchpoints = (await listProposalsForEng(id))
            .map((p) => p.parsed_markdown)
            .filter(Boolean);
          gen = await generateTailoredProposal({
            clientName: engagement.client || engagement.name,
            engagementSpecMarkdown: engagementMd,
            masterSpecMarkdown: null,
            sourceTouchpoints,
          });
        }
      } finally {
        try { await clearEngagementAsyncStatus(id); } catch { /* non-fatal */ }
      }
    }

    // #3: persist this generation so the engagement has a history. Always
    // store the markdown — for md/docx we'd already have it; for gdoc we
    // store it too so users can recover the underlying source if needed.
    let recordedRow = null;
    try {
      recordedRow = await recordGeneratedProposal({
        engagementId: id,
        specVersion: spec.version,
        mode,
        format,
        markdown: gen.markdown,
        costUsd: gen.costUsd,
        modelKey: gen.modelKey,
        generatedBy: pickActor(req),
      });
    } catch (err) {
      // Don't fail the export if persistence fails — just log.
      console.error('[engagements] failed to record generated proposal:', err.message);
    }

    if (format === 'md') {
      return {
        __raw_response: true,
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.md"`,
          'Cache-Control': 'no-store',
          'X-Generation-Cost-Usd': gen.costUsd.toFixed(4),
          'X-Generation-Cached': cached ? '1' : '0',
        },
        body: gen.markdown,
      };
    }

    if (format === 'docx') {
      // Brand-aware export — same typography as contracts (mig 145 brand
      // profile chain: counterparty by client → default → fallback).
      const buffer = await renderEngagementSpecDocx({
        markdown: gen.markdown,
        engagement,
        spec,
      });
      return {
        __raw_response: true,
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${filenameBase}.docx"`,
          'Cache-Control': 'no-store',
          'X-Generation-Cost-Usd': gen.costUsd.toFixed(4),
          'X-Generation-Cached': cached ? '1' : '0',
        },
        body: buffer,
      };
    }

    // gdoc: same impersonation resolution path as the spec gdoc export
    const actor = pickActor(req);
    let userEmail = body?.user_email || null;
    if (!userEmail && actor && actor.includes('@')) userEmail = actor;
    if (!userEmail && actor) {
      const { query } = await import('../db.js');
      const r = await query(
        `SELECT email FROM agent_graph.board_members WHERE github_username = $1 LIMIT 1`,
        [actor]
      );
      if (r.rows[0]?.email) userEmail = r.rows[0].email;
    }
    if (!userEmail) userEmail = process.env.GOOGLE_IMPERSONATE_EMAIL || null;
    if (!userEmail) {
      throw badRequest(`Could not resolve a workspace email to impersonate. Actor was "${actor}".`);
    }

    const title = engagement.is_master
      ? `Proposal Template (from Master Spec v${spec.version})`
      : `Proposal — ${engagement.client || engagement.name} (v${spec.version})`;
    const result = await exportSpecToGoogleDoc({
      markdown: gen.markdown,
      title,
      userEmail,
      folderId: body?.folder_id || undefined,
    });
    // Update the recorded row with the Doc URL (it was inserted before the
    // Drive call so we have it even if the upload fails).
    if (recordedRow) {
      try {
        const { query } = await import('../db.js');
        await query(
          `UPDATE engagements.generated_proposals SET gdoc_url = $2, gdoc_id = $3 WHERE id = $1`,
          [recordedRow.id, result.url, result.docId]
        );
      } catch (err) {
        console.error('[engagements] failed to attach gdoc_url to generated_proposals row:', err.message);
      }
    }
    return { ...result, title, impersonated: userEmail, costUsd: gen.costUsd, cached };
  });

  // ---------- GENERATED PROPOSAL HISTORY ----------

  routes.set('GET /api/engagements/:id/generated-proposals', async (req) => {
    const parts = pathParts(req);
    // .../engagements/:id/generated-proposals
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');
    const proposals = await listGeneratedProposals(id);
    return { proposals };
  });

  routes.set('GET /api/engagements/:id/generated-proposals/:gpid', async (req) => {
    const parts = pathParts(req);
    // .../generated-proposals/:gpid
    const gpid = parts[parts.length - 1];
    if (!UUID_RE.test(gpid)) throw badRequest('invalid generated proposal id');
    const url = new URL(req.url, 'http://localhost');
    const wantFormat = (url.searchParams.get('format') || 'json').toLowerCase();

    const gp = await getGeneratedProposal(gpid);
    if (!gp) throw notFound('generated proposal not found');

    if (wantFormat === 'md') {
      return {
        __raw_response: true,
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="proposal-${gp.mode}-v${gp.spec_version}-${gp.id.slice(0, 8)}.md"`,
          'Cache-Control': 'no-store',
        },
        body: gp.markdown,
      };
    }

    if (wantFormat === 'docx') {
      // Brand-aware export: pull the engagement + spec context attached to
      // this generated proposal so the DOCX carries the same fonts/sizes/
      // colors/logo/footer the contract renderer applies. Missing engagement
      // (deleted) falls back to the default brand profile inside the
      // renderer.
      const { getEngagement } = await import('../../../lib/engagements/db.js');
      const engagement = gp.engagement_id
        ? await getEngagement(gp.engagement_id, { principal: SYSTEM_PRINCIPAL }).catch(() => null)
        : null;
      const buffer = await renderEngagementSpecDocx({
        markdown: gp.markdown,
        engagement,
        spec: { version: gp.spec_version },
      });
      return {
        __raw_response: true,
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="proposal-${gp.mode}-v${gp.spec_version}-${gp.id.slice(0, 8)}.docx"`,
          'Cache-Control': 'no-store',
        },
        body: buffer,
      };
    }

    return { proposal: gp };
  });

  routes.set('DELETE /api/engagements/:id/generated-proposals/:gpid', async (req) => {
    const parts = pathParts(req);
    const gpid = parts[parts.length - 1];
    if (!UUID_RE.test(gpid)) throw badRequest('invalid generated proposal id');
    const deleted = await deleteGeneratedProposal(gpid);
    if (!deleted) throw notFound('generated proposal not found');
    return { ok: true, deleted: { id: deleted.id } };
  });

  // ---------- UPLOAD HAND-EDITED PROPOSAL ----------
  // Board members routinely export the generated .docx, edit it in Word /
  // Google Docs, and want the contract drafter to fold THAT version into the
  // legal template — not the LLM output. This endpoint accepts a .docx,
  // extracts its markdown via the same mammoth pipeline used by
  // /api/contracts/ingest-proposal, records a new tailored-client
  // generated_proposals row, and auto-approves it. The next draft-contract
  // call uses the uploaded markdown.
  //
  // Body: { filename, content_base64 }
  // Only non-master engagements (mode is always 'tailored-client'; master
  // engagements emit generic-template, which isn't contract-eligible).

  routes.set('POST /api/engagements/:id/generated-proposals/upload', async (req, body) => {
    const parts = pathParts(req);
    // /api/engagements/:id/generated-proposals/upload  → :id at index 2
    const id = parts[2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');

    const { filename, content_base64 } = body || {};
    if (!filename || !content_base64) {
      throw badRequest('filename and content_base64 are required');
    }
    if (!/\.docx$/i.test(filename)) {
      throw badRequest('Only .docx uploads are supported');
    }
    const buf = Buffer.from(content_base64, 'base64');
    if (buf.length === 0) throw badRequest('Empty file');
    if (buf.length > 25 * 1024 * 1024) {
      const e = new Error(`File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB, max 25 MB)`);
      e.statusCode = 413;
      throw e;
    }

    const actor = pickActor(req);

    // Need the engagement (for is_master gate) and its spec.version so the
    // uploaded row sits at the same version as the generations it replaces.
    const { engagement, spec } = await loadSpecForExport(id);
    if (engagement.is_master) {
      throw badRequest(
        'Cannot upload a hand-edited proposal on a master engagement — masters emit generic templates, not committed client proposals'
      );
    }

    const { extractProposal } = await import('../../../lib/contracts/proposal-ingest.js');
    let extracted;
    try {
      extracted = await extractProposal(buf);
    } catch (err) {
      const e = new Error(`Failed to parse uploaded .docx: ${err.message}`);
      e.statusCode = 422;
      throw e;
    }
    if (!extracted.markdown) {
      const e = new Error('No content could be extracted from the uploaded .docx');
      e.statusCode = 422;
      throw e;
    }

    const recorded = await recordGeneratedProposal({
      engagementId: id,
      specVersion: spec.version,
      mode: 'tailored-client',
      format: 'docx',
      markdown: extracted.markdown,
      costUsd: 0,
      modelKey: 'hand-uploaded',
      generatedBy: `upload:${actor}`,
    });

    // Auto-approve — the whole point of an upload is "use this one instead."
    // approveGeneratedProposal clears any prior approved tailored-client row
    // on the same engagement (partial unique index guarantees uniqueness).
    try {
      await approveGeneratedProposal({ id: recorded.id, actor });
    } catch (err) {
      // Surface but don't unwind the insert — the row is in history; user
      // can approve manually from the UI if auto-approve hit a race.
      console.warn(`[upload-proposal] auto-approve failed for ${recorded.id}: ${err.message}`);
    }

    // Re-fetch with approved_at populated for the response.
    const final = await getGeneratedProposal(recorded.id);
    return {
      proposal: final,
      extracted: {
        chars: extracted.markdown.length,
        title: extracted.title,
      },
    };
  });

  // ---------- APPROVE / UNAPPROVE A TAILORED PROPOSAL ----------
  // Approving anchors which exact proposal markdown the contract drafter
  // will fold into a legal template. At most one per engagement at a time
  // (enforced by partial unique index in migration 124).

  routes.set('POST /api/engagements/:id/generated-proposals/:gpid/approve', async (req) => {
    const parts = pathParts(req);
    // .../engagements/:id/generated-proposals/:gpid/approve
    const gpid = parts[parts.length - 2];
    if (!UUID_RE.test(gpid)) throw badRequest('invalid generated proposal id');
    try {
      const proposal = await approveGeneratedProposal({ id: gpid, actor: pickActor(req) });
      return { proposal };
    } catch (err) {
      if (/not found/i.test(err.message)) throw notFound(err.message);
      if (/cannot approve|tailored-client/i.test(err.message)) throw badRequest(err.message);
      throw err;
    }
  });

  routes.set('POST /api/engagements/:id/generated-proposals/:gpid/unapprove', async (req) => {
    const parts = pathParts(req);
    const gpid = parts[parts.length - 2];
    if (!UUID_RE.test(gpid)) throw badRequest('invalid generated proposal id');
    try {
      const proposal = await unapproveGeneratedProposal({ id: gpid, actor: pickActor(req) });
      return { proposal };
    } catch (err) {
      if (/not found/i.test(err.message)) throw notFound(err.message);
      throw err;
    }
  });

  // ---------- DRAFT CONTRACT FROM APPROVED PROPOSAL ----------
  // Fire-and-forget: the LLM merge typically runs 15-30s, which is fine but
  // close enough to Cloudflare's 100s ceiling that we mirror the synth /
  // generate-proposal pattern. Stamp engagement.async_status, kick the
  // drafter into a microtask, return immediately. Client polls.

  routes.set('POST /api/engagements/:id/draft-contract', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/draft-contract
    const id = parts[parts.length - 2];
    if (!UUID_RE.test(id)) throw badRequest('invalid engagement id');

    const generatedProposalId = body?.generated_proposal_id;
    if (!generatedProposalId || !UUID_RE.test(generatedProposalId)) {
      throw badRequest('generated_proposal_id is required');
    }
    const templateSlugOrId = (body?.template || 'service-proposal').toString();
    const actor = pickActor(req);

    // Validate up-front: engagement exists, proposal is approved, no other
    // async job is running. These checks are cheap and stay synchronous so
    // the client sees a 400/404 immediately rather than after a roundtrip.
    // STAQPRO-618: scope the existence check to the caller.
    const principal = await resolvePrincipalFor(req);
    const engagement = await (await import('../../../lib/engagements/db.js')).getEngagement(id, { principal });
    if (!engagement) throw notFound('engagement not found');
    if (engagement.async_status) {
      throw badRequest(`engagement is currently busy (${engagement.async_status}) — wait for it to finish`);
    }
    const gp = await getGeneratedProposal(generatedProposalId);
    if (!gp) throw notFound('generated proposal not found');
    if (gp.engagement_id !== id) throw badRequest('proposal does not belong to this engagement');
    if (!gp.approved_at) throw badRequest('proposal must be approved before drafting a contract');

    // Stamp the async status so the existing AsyncProgressBanner picks it up.
    try {
      await setEngagementAsyncStatus(id, {
        status: 'drafting_contract',
        progress: {
          stage: 'drafting_contract',
          label: `Drafting contract for ${engagement.client || engagement.name} (template: ${templateSlugOrId})`,
        },
      });
    } catch { /* non-fatal */ }

    Promise.resolve().then(async () => {
      try {
        await draftContractFromApprovedProposal({
          engagementId: id,
          generatedProposalId,
          templateSlugOrId,
          actor,
          modelKey: body?.model_key,
          force: body?.force === true,
        });
      } catch (err) {
        console.error(`[draft-contract async] failed for engagement ${id}: ${err.message}`);
        if (err.stack) console.error(err.stack);
      } finally {
        try { await clearEngagementAsyncStatus(id); } catch { /* non-fatal */ }
      }
    });

    return {
      engagement_id: id,
      generated_proposal_id: generatedProposalId,
      template: templateSlugOrId,
      status: 'drafting',
      message: 'Contract drafting started in the background. The page will auto-refresh when the draft is ready (~15-30s typical).',
    };
  });

  // ---------- CONFLICT RESOLVE / DISMISS ----------

  routes.set('POST /api/engagements/:id/conflicts/:cid/resolve', async (req, body) => {
    const parts = pathParts(req);
    // .../engagements/:id/conflicts/:cid/resolve
    const cid = parts[parts.length - 2];
    if (!UUID_RE.test(cid)) throw badRequest('invalid conflict id');

    const actor = pickActor(req);
    const action = body?.action || 'resolve';

    if (action === 'dismiss') {
      const conflict = await dismissConflict({ conflictId: cid, actor });
      if (!conflict) throw notFound('conflict not found or already closed');
      return { conflict };
    }

    if (!body?.resolution || typeof body.resolution !== 'object') {
      throw badRequest('resolution object required (e.g. { chosen_option_index: 0, applied_text: "..." })');
    }
    const conflict = await resolveConflict({
      conflictId: cid,
      resolution: body.resolution,
      actor,
    });
    if (!conflict) throw notFound('conflict not found or already closed');

    // If the resolution included applied_text and a section_id, write it into the section.
    if (typeof body.resolution.applied_text === 'string' && conflict.section_id) {
      const result = await saveSectionEdit({
        sectionId: conflict.section_id,
        newBody: body.resolution.applied_text,
        actor,
      });
      return { conflict, section: result.section, edit: result.edit };
    }
    return { conflict };
  });
}
