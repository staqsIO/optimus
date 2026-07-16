/**
 * RAG client — unified knowledge base access.
 *
 * Strategy: local retriever first (pgvector in Optimus DB), then
 * brain-rag API fallback (Carlos's external service, transition period).
 *
 * Graceful degradation: if both are unavailable, returns null (same
 * pattern as Neo4j). Agents proceed without RAG context.
 *
 * Env vars:
 *   BRAIN_RAG_API_URL — base URL for fallback (default: brain-rag Railway URL)
 *   BRAIN_RAG_API_KEY — Bearer token for fallback auth
 *   OPENAI_API_KEY    — Required for local embeddings
 */

import { retrieveContext } from './retriever.js';
import { SCOPE_VALIDATED_BY_PARENT } from './scope.js';
import { createLogger } from '../logger.js';
const log = createLogger('rag/client');

const RAG_API_URL = process.env.BRAIN_RAG_API_URL || 'https://brain-rag-api-production.up.railway.app';
const RAG_API_KEY = process.env.BRAIN_RAG_API_KEY || '';
const RAG_TIMEOUT_MS = 10_000;

// Cache conversation IDs by scope (avoids creating one per query)
const conversationCache = new Map();

/**
 * Query the RAG knowledge base for context relevant to an email/task.
 *
 * @param {string} query - Natural language query (e.g., "What do we know about Eric Gang?")
 * @param {Object} [opts]
 * @param {boolean} [opts.kbOnly=true] - Only return answers from knowledge base (no hallucination)
 * @param {string} [opts.scope='optimus'] - Conversation scope for caching
 * @param {string} [opts.viewerMemberId] - Board member UUID: shared corpus + that member's private docs
 * @param {boolean} [opts.includeOrgWide=true] - With viewerMemberId, include owner_id NULL documents
 * @param {boolean} [opts.sharedDocumentsOnly=false] - Only org-wide documents (when message has no owner)
 * @returns {Promise<{ answer: string, citations: Array } | null>} Answer with citations, or null if unavailable
 */
export async function queryRAG(queryText, opts = {}) {
  const {
    kbOnly = true,
    scope = 'optimus',
    viewerMemberId = null,
    includeOrgWide = true,
    sharedDocumentsOnly = false,
    retrieverScope, // Worktree 1: new { ownerId } | { org:true, agentId } shape
  } = opts;

  // Worktree 1 (RAG scope hardening): derive a retriever scope. New callers
  // pass `retrieverScope` directly; legacy callers still supply the
  // viewerMemberId shim, which we translate into { ownerId } here so the
  // retriever's deny-by-default gate is satisfied without forcing every
  // existing call site to migrate at the same time.
  //
  // Phase-2 tenancy: this is an agent/system path (no board viewer). Attach
  // readOrgIds from syntheticPrincipal(Staqs) so content.match_chunks fails
  // closed on owner_org_id. Caller-supplied retrieverScope is honoured as-is
  // (it already carries its own readOrgIds from the HTTP/board boundary).
  const { CURRENT_ORG_READ_SCOPE } = await import('../tenancy/scope.js');
  const STAQS_READ_ORGS = CURRENT_ORG_READ_SCOPE;
  let derivedScope = retrieverScope;
  if (!derivedScope && viewerMemberId) {
    derivedScope = { ownerId: viewerMemberId, readOrgIds: STAQS_READ_ORGS };
  }

  // Try local retriever first (pgvector in Optimus DB).
  //
  // STAQPRO-570: validateScope no longer soft-degrades a bare legacy opts triple
  // — it hard-throws. This client IS the validated boundary for the agent/system
  // path: it has already resolved the real org gate (STAQS_READ_ORGS via
  // syntheticPrincipal, or the caller's retrieverScope). When there is no per-
  // viewer owner and no caller scope (e.g. claw-campaigner strategy planning),
  // we mark the opts as an internal passthrough (`__scopeValidatedByParent`) so
  // retrieveContext consumes the resolved org gate fail-closed instead of
  // throwing. The org dimension (readOrgIds) is what bounds tenant visibility;
  // the null owner leaves the per-user gate open to the org-shared corpus.
  const passthroughOpts = {
    scope,
    ownerId: viewerMemberId,
    includeOrgWide,
    sharedDocumentsOnly,
    // Phase-2 tenancy: thread the Staqs org gate. An empty org set would fail
    // closed and the org-shared corpus would vanish.
    readOrgIds: STAQS_READ_ORGS,
  };
  if (!derivedScope) {
    // No validated scope arg to pass — flag this opts payload as the already-
    // resolved org gate so validateScope's Mode 2 passthrough accepts it.
    passthroughOpts[SCOPE_VALIDATED_BY_PARENT] = true;
  }
  try {
    const localResult = await retrieveContext(queryText, passthroughOpts, derivedScope);
    if (localResult) {
      // Surface any document-level participants on the returned citations so
      // the calling agent can render "who was at the meeting" context, even
      // when the chunk text itself never mentions those names. This fixes the
      // "there was no meeting with John" bug when John was a speaker but the
      // transcript text never included his name as a word.
      if (Array.isArray(localResult.citations)) {
        for (const c of localResult.citations) {
          const p = c?.metadata?.document_participants;
          if (Array.isArray(p) && p.length > 0 && !c.participants) {
            c.participants = p;
          }
        }
      }
      log.info(`Local retriever hit: ${localResult.citations?.length || 0} citations`);
      return localResult;
    }
  } catch (err) {
    log.info(`Local retriever unavailable: ${err.message}`);
  }

  // Fallback to brain-rag API.
  //
  // Phase-2 tenancy (live read-leak): the external brain-rag service has NO
  // owner_org_id concept and cannot honour cross-tenant isolation. The local
  // retriever above already enforced the org gate (content.match_chunks /
  // lexicalChunkSearch fail closed on readOrgIds). If a multi-tenant org scope
  // is in effect for this call, we MUST NOT fall through to the ungated external
  // API — doing so would leak another org's documents. Every queryRAG path here
  // runs under an org scope (board callers pass retrieverScope.readOrgIds;
  // agent/system callers get STAQS_READ_ORGS), so this guard is effectively
  // always on; it is the explicit fail-closed contract (SPEC §0 P1) rather than
  // relying on RAG_API_KEY being unset in prod. brain-rag is DEPRECATED (its
  // Supabase was retired 2026-03-30; corpus consolidated into Optimus) — the
  // fallback is legacy and slated for removal.
  const callerReadOrgIds =
    (derivedScope && Array.isArray(derivedScope.readOrgIds) && derivedScope.readOrgIds.length > 0
      ? derivedScope.readOrgIds
      : STAQS_READ_ORGS) || [];
  if (Array.isArray(callerReadOrgIds) && callerReadOrgIds.length > 0) {
    log.warn('brain-rag fallback skipped: org-scoped call — external API is org-unaware (fail-closed)');
    return null;
  }

  // Fallback to brain-rag API (only reachable for legacy org-less callers, if any)
  if (!RAG_API_KEY) return null;

  try {
    // Get or create conversation for this scope
    let conversationId = conversationCache.get(scope);
    if (!conversationId) {
      const createRes = await fetch(`${RAG_API_URL}/api/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RAG_API_KEY}`,
        },
        body: JSON.stringify({ title: `optimus-agent-${scope}` }),
        signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
      });
      if (!createRes.ok) return null;
      const conv = await createRes.json();
      conversationId = conv.id;
      conversationCache.set(scope, conversationId);
    }

    // Send query
    const msgRes = await fetch(`${RAG_API_URL}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RAG_API_KEY}`,
      },
      body: JSON.stringify({
        content: queryText,
        options: { kb_only: kbOnly },
      }),
      signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
    });

    if (!msgRes.ok) return null;
    const message = await msgRes.json();

    return {
      answer: message.content || message.text || '',
      citations: message.citations || message.sources || [],
    };
  } catch {
    // RAG unavailable — graceful degradation (same as Neo4j pattern)
    return null;
  }
}

/**
 * Build a RAG context block for an agent prompt.
 * Queries the knowledge base about the email sender and topic.
 *
 * @param {Object} email - inbox.messages row
 * @returns {Promise<string|null>} Context block to inject into agent prompt, or null
 */
export async function getRAGContext(email) {
  if (!email?.from_address) return null;
  log.info(`Querying knowledge base for ${email.from_address} / ${email.subject || '(no subject)'}`);

  const senderName = email.from_name || email.from_address.split('@')[0];
  const subject = email.subject || '';

  const viewerMemberId = email.owner_id || null;
  const ragOpts = viewerMemberId
    ? { viewerMemberId, includeOrgWide: true, sharedDocumentsOnly: false }
    : { viewerMemberId: null, includeOrgWide: true, sharedDocumentsOnly: true };

  // Query for sender context + topic context in parallel
  const [senderCtx, topicCtx] = await Promise.all([
    queryRAG(`What do we know about ${senderName} (${email.from_address})? Recent interactions, projects, commitments.`, { scope: 'sender', ...ragOpts }),
    subject ? queryRAG(`What context do we have about: ${subject}`, { scope: 'topic', ...ragOpts }) : null,
  ]);

  if (!senderCtx && !topicCtx) {
    log.info('No context found from knowledge base');
    return null;
  }
  log.info(`Got context: sender=${!!senderCtx?.answer}, topic=${!!topicCtx?.answer}`);

  const parts = ['KNOWLEDGE BASE CONTEXT (from meeting transcripts and documents):'];
  if (senderCtx?.answer) {
    parts.push(`\nABOUT THE SENDER (${senderName}):\n${senderCtx.answer}`);
  }
  if (topicCtx?.answer) {
    parts.push(`\nRELATED CONTEXT:\n${topicCtx.answer}`);
  }
  parts.push('\nIMPORTANT: Use this context to inform your response. Do NOT invent details beyond what is provided here.');

  return parts.join('\n');
}
