/**
 * Auto-build an engagement from selected client knowledge.
 *
 * Given a client name and a set of selected source ids (from a prior
 * client-search), this:
 *   1. Creates a new engagement (kind='other', client=clientName)
 *   2. Loads the full content of each selected item (transcript chunks
 *      concatenated, email body fetched, calendar event formatted, signal
 *      content read)
 *   3. Ingests each item as a proposal (kind='note', source_type='paste')
 *      with a title that identifies provenance
 *   4. Runs a synth pass on the new engagement (which inherits the master)
 *   5. Returns the engagement id + synth result
 *
 * The synth is *not* re-run by the caller; the auto-build does it inline so
 * the new engagement is immediately usable.
 */

import { query } from '../db.js';
import {
  createEngagement, rememberClientDomains, getEngagement, SYSTEM_PRINCIPAL,
  setEngagementAsyncStatus, updateEngagementAsyncProgress, clearEngagementAsyncStatus,
} from './db.js';
import { ingestPaste } from './ingest.js';
import { synthesizeEngagementSpec } from './synth.js';
import { createLogger } from '../logger.js';

const log = createLogger('engagements/auto-build');

// Per-source caps to keep proposal ingest reasonable. Transcripts are huge,
// so the cap is tightest there.
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_EMAIL_CHARS = 8_000;

export async function autoBuildEngagement({
  clientName,
  engagementName,
  selections,
  actor,
  existingEngagementId = null,
  confirmedDomains = [],
}) {
  if (!clientName) throw new Error('clientName is required');
  if (!actor) throw new Error('actor is required');
  selections = selections || {};

  const calendarIds = selections.calendar_ids || [];
  const transcriptIds = selections.transcript_ids || [];
  const messageIds = selections.message_ids || [];
  const signalIds = selections.signal_ids || [];

  const totalSelected = calendarIds.length + transcriptIds.length + messageIds.length + signalIds.length;
  if (totalSelected === 0) {
    throw new Error('No source items selected — pick at least one meeting, transcript, email, or signal.');
  }

  // 0. Best-effort organization match (#6). Look up the client name + any
  // confirmed domains in signal.organizations. If we find one, stamp its id
  // on the engagement so other surfaces can aggregate by org later.
  const matchedOrgId = await matchOrganization(clientName, confirmedDomains);

  // 1. Create OR reuse engagement
  let engagement;
  let isNew = true;
  if (existingEngagementId) {
    engagement = await getEngagement(existingEngagementId, { principal: SYSTEM_PRINCIPAL });
    if (!engagement) throw new Error(`existing engagement not found: ${existingEngagementId}`);
    if (engagement.is_master) throw new Error('Cannot ingest sources into the master engagement.');
    isNew = false;
    log.info(`auto-build: appending ${totalSelected} sources to existing engagement ${engagement.id}`);
  } else {
    engagement = await createEngagement({
      name: engagementName?.trim() || `Proposal for ${clientName}`,
      client: clientName,
      kind: 'other',
      createdBy: actor,
    });
    if (matchedOrgId) {
      await query(
        `UPDATE engagements.engagements SET organization_id = $1 WHERE id = $2`,
        [matchedOrgId, engagement.id]
      );
      engagement.organization_id = matchedOrgId;
    }
    log.info(`auto-build: created engagement ${engagement.id} for "${clientName}"${matchedOrgId ? ` (linked org ${matchedOrgId})` : ''} with ${totalSelected} sources`);
  }

  // 2. Load + ingest each selection
  let ingestedCount = 0;
  let ingestErrors = [];

  // Mark this engagement as actively ingesting so the UI can show a banner.
  try {
    await setEngagementAsyncStatus(engagement.id, {
      status: 'ingesting',
      progress: {
        stage: 'ingesting',
        current: 0,
        total: totalSelected,
        label: `Ingesting ${totalSelected} source${totalSelected === 1 ? '' : 's'}`,
      },
    });
  } catch (err) {
    log.warn(`could not set async_status to ingesting: ${err.message}`);
  }

  async function bumpProgress(label) {
    try {
      await updateEngagementAsyncProgress(engagement.id, {
        stage: 'ingesting',
        current: ingestedCount,
        total: totalSelected,
        label,
      });
    } catch { /* non-fatal */ }
  }

  // --- Calendar events ---
  for (const id of calendarIds) {
    try {
      const ev = await loadCalendarEvent(id);
      if (!ev) { log.warn(`calendar event not found: ${id}`); continue; }
      const md = formatCalendarEventAsMarkdown(ev);
      await ingestPaste({
        engagementId: engagement.id,
        title: `Meeting: ${ev.title || '(untitled)'}`,
        kind: inferKindFromTitle(ev.title),
        content: md,
        createdBy: actor,
      });
      ingestedCount++;
      await bumpProgress(`Ingested calendar event: ${ev.title || '(untitled)'}`);
    } catch (err) {
      log.warn(`failed to ingest calendar event ${id}: ${err.message}`);
      ingestErrors.push({ kind: 'calendar', id, error: err.message });
    }
  }

  // --- Transcripts ---
  for (const id of transcriptIds) {
    try {
      const t = await loadTranscriptText(id);
      if (!t) { log.warn(`transcript not found: ${id}`); continue; }
      await ingestPaste({
        engagementId: engagement.id,
        title: `Transcript: ${t.title}`,
        kind: inferKindFromTitle(t.title),
        content: t.markdown,
        createdBy: actor,
      });
      ingestedCount++;
      await bumpProgress(`Ingested transcript: ${t.title}`);
    } catch (err) {
      log.warn(`failed to ingest transcript ${id}: ${err.message}`);
      ingestErrors.push({ kind: 'transcript', id, error: err.message });
    }
  }

  // --- Emails (with on-demand full body fetch via Gmail) ---
  for (const id of messageIds) {
    try {
      const m = await loadEmail(id);
      if (!m) { log.warn(`email not found: ${id}`); continue; }
      let body = null;
      if (m.provider === 'gmail' && m.provider_msg_id) {
        try {
          const { fetchEmailBody } = await import('../../autobot-inbox/src/gmail/client.js');
          body = await fetchEmailBody(m.provider_msg_id, m.account_id);
        } catch (err) {
          log.warn(`gmail body fetch failed for ${id}: ${err.message}`);
        }
      }
      const md = formatEmailAsMarkdown(m, body);
      await ingestPaste({
        engagementId: engagement.id,
        title: `Email: ${m.subject || '(no subject)'}`,
        kind: inferKindFromTitle(m.subject),
        content: md,
        createdBy: actor,
      });
      ingestedCount++;
      await bumpProgress(`Ingested email: ${m.subject || '(no subject)'}`);
    } catch (err) {
      log.warn(`failed to ingest email ${id}: ${err.message}`);
      ingestErrors.push({ kind: 'email', id, error: err.message });
    }
  }

  // --- Signals (bundled into ONE proposal — they're small and high-density) ---
  if (signalIds.length > 0) {
    try {
      const sigs = await loadSignals(signalIds);
      if (sigs.length) {
        const md = formatSignalsAsMarkdown(sigs);
        await ingestPaste({
          engagementId: engagement.id,
          title: `Signals (${sigs.length} extracted facts)`,
          kind: 'note',
          content: md,
          createdBy: actor,
        });
        ingestedCount++;
        await bumpProgress(`Ingested ${sigs.length} signal${sigs.length === 1 ? '' : 's'}`);
      }
    } catch (err) {
      log.warn(`failed to ingest signals batch: ${err.message}`);
      ingestErrors.push({ kind: 'signals', error: err.message });
    }
  }

  if (ingestedCount === 0) {
    throw new Error(`No sources were ingested successfully — engagement ${engagement.id} ${isNew ? 'created' : 'unchanged'} but no proposals added. Errors: ${ingestErrors.map((e) => e.error).join('; ')}`);
  }

  // 2b. Domain memory: if the user confirmed a set of domains, persist them
  // so future expansions for this client skip the LLM. (#12)
  if (Array.isArray(confirmedDomains) && confirmedDomains.length) {
    try {
      await rememberClientDomains(clientName, confirmedDomains);
    } catch (err) {
      log.warn(`failed to persist client domain memory: ${err.message}`);
    }
  }

  // 3. Synth
  let synthResult = null;
  let synthError = null;
  try {
    await setEngagementAsyncStatus(engagement.id, {
      status: 'synthesizing',
      progress: {
        stage: 'synthesizing',
        label: `Synthesizing spec from ${ingestedCount} ingested source${ingestedCount === 1 ? '' : 's'}`,
      },
    });
  } catch { /* non-fatal */ }
  try {
    synthResult = await synthesizeEngagementSpec(engagement.id, { actor });
    log.info(`auto-build: synth complete for ${engagement.id} (cost $${synthResult.costUsd.toFixed(4)})`);
  } catch (err) {
    synthError = err.message;
    log.warn(`auto-build: synth failed (engagement still usable): ${err.message}`);
  }
  // Clear status regardless of synth outcome — the job is done.
  try { await clearEngagementAsyncStatus(engagement.id); } catch { /* non-fatal */ }

  return {
    engagement_id: engagement.id,
    engagement_name: engagement.name,
    is_new: isNew,
    ingested_count: ingestedCount,
    ingest_errors: ingestErrors,
    synth_result: synthResult,
    synth_error: synthError,
  };
}

/**
 * Heuristic for tagging an ingested source as draft / finalized / note.
 * Conservative: most things get 'note'. Only explicit signal markers
 * promote to 'finalized'. Used so the synth prompt's "finalized outweighs
 * draft" rule has actual signal to work with.
 */
/**
 * Best-effort match of a client name + domains against signal.organizations.
 * Tries: primary_domain exact match, slug = name slug, name ILIKE, alias
 * resolved status. Returns first match's id or null.
 */
async function matchOrganization(clientName, domains = []) {
  try {
    if (domains.length) {
      const params = [...domains.map((d) => String(d).toLowerCase())];
      const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
      const r = await query(
        `SELECT id FROM signal.organizations
          WHERE LOWER(primary_domain) = ANY(ARRAY[${placeholders}]::text[])
          LIMIT 1`,
        params
      );
      if (r.rows[0]) return r.rows[0].id;
    }
    const slug = String(clientName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const byName = await query(
      `SELECT id FROM signal.organizations
        WHERE slug = $1 OR LOWER(name) = LOWER($2)
        ORDER BY CASE WHEN slug = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [slug, clientName]
    );
    if (byName.rows[0]) return byName.rows[0].id;
  } catch (err) {
    log.warn(`organization match skipped: ${err.message}`);
  }
  return null;
}

function inferKindFromTitle(title) {
  if (!title) return 'note';
  const t = String(title).toLowerCase();
  if (/\b(final|finalized|signed|approved|executed|countersigned)\b/.test(t)) return 'finalized';
  if (/\b(rfp|sow|statement of work|scope of work|master services agreement|msa)\b/.test(t)) return 'finalized';
  if (/\b(draft|wip|proposal|tentative)\b/.test(t)) return 'draft';
  return 'note';
}

// ============================================================
// Loaders + markdown formatters per source
// ============================================================

async function loadCalendarEvent(id) {
  const r = await query(
    `SELECT id, title, description, organizer_email, start_at, end_at, attendees, location, hangout_link
       FROM inbox.calendar_events WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

function formatCalendarEventAsMarkdown(ev) {
  const lines = [];
  lines.push(`# ${ev.title || '(untitled meeting)'}`);
  lines.push('');
  if (ev.start_at) lines.push(`**When:** ${new Date(ev.start_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if (ev.organizer_email) lines.push(`**Organizer:** ${ev.organizer_email}`);
  if (Array.isArray(ev.attendees) && ev.attendees.length) {
    lines.push(`**Attendees:** ${ev.attendees.map((a) => a.email || a.displayName).filter(Boolean).join(', ')}`);
  }
  if (ev.location) lines.push(`**Location:** ${ev.location}`);
  if (ev.hangout_link) lines.push(`**Meet link:** ${ev.hangout_link}`);
  if (ev.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(ev.description);
  }
  return lines.join('\n');
}

/**
 * Scope-relevance query used for semantic chunk selection. Tuned for
 * extracting proposal-worthy content from a meeting transcript.
 */
const SCOPING_QUERY = 'Project scope, deliverables, timeline, budget, milestones, stack and technology choices, risks, integrations, acceptance criteria, decisions and commitments made by the client about the work to be done.';

async function loadTranscriptText(id) {
  const docR = await query(
    `SELECT id, title, source, metadata FROM content.documents WHERE id = $1`,
    [id]
  );
  const doc = docR.rows[0];
  if (!doc) return null;

  const chunksR = await query(
    `SELECT id, chunk_index, text, metadata,
            CASE WHEN embedding IS NULL THEN false ELSE true END AS has_embedding
       FROM content.chunks
      WHERE document_id = $1
      ORDER BY chunk_index ASC`,
    [id]
  );
  if (!chunksR.rows.length) return null;

  // Estimate raw transcript size. If it fits comfortably under the cap,
  // just emit everything in order. Only do semantic selection when we'd
  // otherwise truncate the tail.
  const rawTotal = chunksR.rows.reduce((s, c) => s + (c.text?.length || 0), 0);
  const useSemanticSelection = rawTotal > MAX_TRANSCRIPT_CHARS;

  let selectedChunks = chunksR.rows;
  let semanticUsed = false;

  if (useSemanticSelection) {
    try {
      const { embedOne } = await import('../rag/embedder.js');
      const queryEmbedding = await embedOne(SCOPING_QUERY);
      // Rank chunks by cosine similarity to the scoping query, keep top-K
      // that fit within the budget, then re-sort them chronologically so
      // the output reads in conversation order, not relevance order.
      const ranked = await query(
        `SELECT id, chunk_index, text, metadata,
                1 - (embedding <=> $1::vector) AS sim
           FROM content.chunks
          WHERE document_id = $2 AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT 200`,
        [JSON.stringify(queryEmbedding), id]
      );
      if (ranked.rows.length > 0) {
        const picked = [];
        let used = 0;
        for (const row of ranked.rows) {
          const len = (row.text?.length || 0) + 20; // header overhead
          if (used + len > MAX_TRANSCRIPT_CHARS) continue;
          picked.push(row);
          used += len;
        }
        // Restore chronological order
        picked.sort((a, b) => a.chunk_index - b.chunk_index);
        selectedChunks = picked;
        semanticUsed = true;
        log.info(`transcript ${id}: semantic-selected ${picked.length}/${ranked.rows.length} chunks (raw=${rawTotal} chars → ${used} chars)`);
      }
    } catch (err) {
      log.warn(`semantic transcript selection failed (falling back to head-truncate): ${err.message}`);
    }
  }

  const lines = [];
  lines.push(`# Transcript: ${doc.title || '(untitled)'}`);
  if (doc.metadata?.happenedAt) {
    lines.push('');
    lines.push(`> Meeting time: ${doc.metadata.happenedAt}`);
  }
  if (semanticUsed) {
    lines.push('');
    lines.push(`> _(${selectedChunks.length} scope-relevant segments selected from a longer transcript via semantic search)_`);
  }
  lines.push('');
  let total = lines.join('\n').length;
  let truncated = false;
  for (const c of selectedChunks) {
    const speaker = Array.isArray(c.metadata?.speakers) && c.metadata.speakers.length
      ? c.metadata.speakers.join(', ')
      : null;
    const ts = c.metadata?.start_timestamp;
    const prefix = [ts && `[${ts}]`, speaker && `**${speaker}:**`].filter(Boolean).join(' ');
    const block = (prefix ? `${prefix} ` : '') + (c.text || '');
    if (total + block.length + 2 > MAX_TRANSCRIPT_CHARS) {
      truncated = true;
      break;
    }
    lines.push(block);
    total += block.length + 1;
  }
  if (truncated && !semanticUsed) {
    lines.push('');
    lines.push(`> _(transcript truncated at ${MAX_TRANSCRIPT_CHARS} chars to keep proposal size manageable)_`);
  }
  return { title: doc.title, markdown: lines.join('\n\n') };
}

async function loadEmail(id) {
  const r = await query(
    `SELECT id, subject, from_address, to_addresses, cc_addresses, received_at,
            snippet, provider, provider_msg_id, account_id
       FROM inbox.messages WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

function formatEmailAsMarkdown(m, fullBody = null) {
  const lines = [];
  lines.push(`# Email: ${m.subject || '(no subject)'}`);
  lines.push('');
  if (m.received_at) lines.push(`**Received:** ${new Date(m.received_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if (m.from_address) lines.push(`**From:** ${m.from_address}`);
  if (Array.isArray(m.to_addresses) && m.to_addresses.length) lines.push(`**To:** ${m.to_addresses.join(', ')}`);
  if (Array.isArray(m.cc_addresses) && m.cc_addresses.length) lines.push(`**Cc:** ${m.cc_addresses.join(', ')}`);
  lines.push('');
  if (fullBody && fullBody.trim()) {
    lines.push(fullBody.trim().slice(0, MAX_EMAIL_CHARS));
    if (fullBody.length > MAX_EMAIL_CHARS) {
      lines.push('');
      lines.push(`> _(truncated at ${MAX_EMAIL_CHARS} chars)_`);
    }
  } else if (m.snippet) {
    lines.push(m.snippet);
    lines.push('');
    lines.push('> _(only Gmail snippet — full body fetch unavailable)_');
  } else {
    lines.push('_(no body available — message metadata only)_');
  }
  return lines.join('\n');
}

async function loadSignals(ids) {
  const r = await query(
    `SELECT id, signal_type, content, direction, domain, due_date, created_at
       FROM inbox.signals
      WHERE id = ANY($1::text[])
      ORDER BY created_at ASC`,
    [ids]
  );
  return r.rows;
}

function formatSignalsAsMarkdown(signals) {
  const lines = [];
  lines.push(`# Extracted Signals`);
  lines.push('');
  lines.push(`${signals.length} signal${signals.length === 1 ? '' : 's'} extracted from meetings and emails with this client.`);
  lines.push('');
  const byType = new Map();
  for (const s of signals) {
    if (!byType.has(s.signal_type)) byType.set(s.signal_type, []);
    byType.get(s.signal_type).push(s);
  }
  for (const [type, list] of byType.entries()) {
    lines.push(`## ${type} (${list.length})`);
    lines.push('');
    for (const s of list) {
      const meta = [s.direction, s.due_date && `due ${new Date(s.due_date).toISOString().slice(0, 10)}`]
        .filter(Boolean).join(' · ');
      lines.push(`- ${s.content}${meta ? ` _(${meta})_` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
