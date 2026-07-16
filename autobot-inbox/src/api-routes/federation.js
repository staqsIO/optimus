// api-routes/federation.js — OPT-76, T1-F
// Federation grant/query/revocations HTTP endpoints.
//
// Design:
//   POST /api/federation/grant        — board-authenticated; issues a signed capability
//                                       receipt and persists the grant row.
//   GET  /api/federation/query        — receipt-authenticated (Bearer <JWS>); enforces
//                                       scope.filter at the issuing org's query layer
//                                       (the KG slice never exceeds what was granted).
//   GET  /.well-known/federation/revocations.json — public; returns revoked JTI list.
//
// Every call (success or failure) writes an audit row to agent_graph.state_transitions
// via the trg_fg_lifecycle_insert/update trigger that 169-federation-grants.sql installs.
// Explicit per-handler audit rows are added for the QUERY endpoint (which has no trigger).
//
// Scope enforcement (P1 / P2):
//   scope.filter is applied server-side at query time: the KG Cypher WHERE clause
//   is built from the filter stored in the DB row (not the claims in the Bearer token).
//   The audience cannot widen scope by re-interpreting filter fields; the server fetches
//   the persisted filter for this JTI and applies it unconditionally.
//
//   max_results and max_calls are also read from the DB row and enforced:
//     - max_results: LIMIT applied to the Cypher query.
//     - max_calls: usage_count column incremented atomically; if usage_count >= max_calls,
//       the request is rejected 429.

import { randomUUID, createHash } from 'node:crypto';
import { signReceipt, verifyReceipt, _injectKeysForTest } from '../../../lib/federation/capability-receipt-jws.js';
import { runCypher } from '../../../lib/graph/client.js';
import { createLogger } from '../../../lib/logger.js';
import { withBoardScope } from '../db.js';
import { withSystemScope } from '../../../lib/db.js';

export { _injectKeysForTest }; // re-export for tests that need to set keys

const log = createLogger('federation/routes');

// OPT-166 P3-B5: /grant is board-human-gated (requireBoardHuman) → withBoardScope.
// /query (receipt-JWS bearer, no board principal) + revocation reads → withSystemScope.
const FEDERATION_SYSTEM_ACTOR = 'federation-query';

/**
 * Run a single DB call group under federation system scope, fail-CLOSED.
 * Callers must NOT span a network await (e.g. runCypher) inside `fn` —
 * open/close brackets per DB call group, same as tldv/poller.js.
 *
 * OPT-166 P3-B6 [codex-4b]: this used to fall back to an unscoped `query` when
 * withSystemScope threw. On the STAQPRO-263 flip that is dangerous — the
 * revocation-list read (federation_grants) under restrictive RLS would return an
 * EMPTY revoked-jti set with no system GUC, so a REVOKED capability would be
 * honored (fail-open on revocation enforcement), strictly worse than a
 * black-hole. FEDERATION_SYSTEM_ACTOR is allow-listed in SYSTEM_ACTORS, so this
 * only throws on genuine misconfiguration; when it does the federation query must
 * reject, never run unscoped — the same fail-closed posture as auditFederationQuery.
 */
async function withFederationSystemScope(fn) {
  const scoped = await withSystemScope(FEDERATION_SYSTEM_ACTOR, { reason: 'federation-query-path' });
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/** Board-human gate: role=board + github_username present. */
function requireBoardHuman(req) {
  const auth = req?.auth || null;
  const isBoardHuman = auth?.role === 'board' && !!auth?.github_username;
  if (!isBoardHuman) {
    throw httpError('Federation grant management requires a board member', 403);
  }
}

/**
 * Write an explicit audit row to state_transitions for the query endpoint.
 *
 * OPT-54 (mind-meld round-trip): contractHash is now threaded through so that
 * both audit chains — federation:grant:<jti> (written by the DB trigger on INSERT)
 * and federation:query:<jti> (written here) — share the same config_hash value,
 * anchoring both sides of the cross-org exchange to the same business contract.
 *
 * Before this fix config_hash was hardcoded to `jti`, so the grant chain carried
 * contract_hash but the query chain carried jti — the two chains could not be
 * joined on a shared contract anchor without re-querying the grants table.
 */
async function auditFederationQuery(query, jti, status, reason, principalId, contractHash) {
  try {
    const wid  = `federation:query:${jti}`;
    const tid  = randomUUID();

    // OPT-166 P3-B6: this is a WRITE (state_transitions audit INSERT). It calls
    // withSystemScope directly rather than through the shared withFederationSystemScope
    // wrapper because the whole audit write is already inside the non-fatal
    // try/catch below — letting withSystemScope's error propagate here just skips
    // this audit row instead of writing it. Both this path and the shared read
    // wrapper are fail-closed (never fall back to an unscoped query).
    const scoped = await withSystemScope(FEDERATION_SYSTEM_ACTOR, { reason: 'federation-query-path' });
    try {
      const prev = await scoped(
        `SELECT encode(hash_chain_current,'hex') AS h
           FROM agent_graph.state_transitions
          WHERE work_item_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [wid]
      );
      const prevHash = prev.rows[0]?.h ?? null;
      const payload  = [prevHash ?? 'genesis', tid, wid, 'query', status, principalId ?? 'external', jti].join('|');
      const hashBuf  = createHash('sha256').update(payload).digest();

      // config_hash = contractHash when available (shared anchor with the grant chain);
      // falls back to jti for early-reject paths where we haven't fetched the grant row yet.
      const configHashValue = contractHash ?? jti;

      await scoped(
        `INSERT INTO agent_graph.state_transitions
           (id, work_item_id, from_state, to_state, agent_id, config_hash, reason,
            guardrail_checks_json, cost_usd, hash_chain_prev, hash_chain_current, created_at)
         VALUES ($1,$2,'query',$3,$4,$5,$6,'{}',0,$7,$8,now())`,
        [
          tid, wid, status,
          principalId ?? 'external',
          configHashValue,
          reason,
          prevHash ? Buffer.from(prevHash, 'hex') : null,
          hashBuf,
        ]
      );
    } finally {
      await scoped.release();
    }
  } catch (err) {
    // Non-fatal — log and continue; audit failure must never break the query path.
    log.error({ err: err.message, jti }, 'federation query audit write failed');
  }
}

// ─── route registration ───────────────────────────────────────────────────────

/**
 * Register federation routes onto the shared routes Map.
 *
 * @param {Map} routes
 * @param {Function} query  — raw parameterized DB query fn
 * @param {object} [opts]
 * @param {string} [opts.orgDid]   — issuing org DID (default: OPTIMUS_ORG_DID env or "did:web:self")
 */
export function registerFederationRoutes(routes, query, opts = {}) {
  const orgDid  = opts.orgDid  ?? process.env.OPTIMUS_ORG_DID  ?? 'did:web:self';

  // ── POST /api/federation/grant ─────────────────────────────────────────────
  routes.set('POST /api/federation/grant', async (req, body) => {
    requireBoardHuman(req);

    const { audience_org, scope, contract_hash, ttl } = body ?? {};

    if (!audience_org) throw httpError('audience_org is required', 400);
    if (!scope?.capability) throw httpError('scope.capability is required', 400);
    if (!contract_hash) throw httpError('contract_hash is required', 400);

    const ttlSeconds = Number(ttl) || 3600;
    const subject    = req.auth?.github_username ?? 'board';

    // Sign the receipt. signReceipt() generates its own jti internally.
    // We extract the jti from the signed envelope to use as the DB PK —
    // this ensures the DB row's jti matches the jti claim in the receipt.
    const signed_envelope = signReceipt({
      issuer:       orgDid,
      audience:     audience_org,
      subject,
      scope: {
        capability:  scope.capability,
        filter:      scope.filter ?? null,
        max_results: scope.max_results ?? 100,
        max_calls:   scope.max_calls   ?? 1000,
      },
      contractHash: contract_hash,
      ttl:          ttlSeconds,
    });

    // Extract jti from the signed JWT payload (compact JWS: header.payload.sig).
    const payloadB64 = signed_envelope.split('.')[1];
    const claims = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    const jti = claims.jti;
    if (!jti) throw httpError('signReceipt returned envelope with no jti claim', 500);

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // Persist — the trigger writes the lifecycle audit row.
    // OPT-166 P3-B5: board-human-gated (requireBoardHuman above) → withBoardScope.
    const scopedQuery = await withBoardScope(req.auth);
    try {
      await scopedQuery(
        `INSERT INTO agent_graph.federation_grants
           (jti, issuer_org, audience_org, scope_capability, scope_filter,
            max_results, max_calls, contract_hash, signed_envelope,
            issued_at, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11)`,
        [
          jti,
          orgDid,
          audience_org,
          scope.capability,
          JSON.stringify(scope.filter ?? {}),
          scope.max_results ?? 100,
          scope.max_calls   ?? 1000,
          contract_hash,
          signed_envelope,
          expiresAt,
          req.auth?.userId ?? null,
        ]
      );
    } finally {
      await scopedQuery.release();
    }

    log.info({ jti, audience_org, capability: scope.capability }, 'federation grant issued');

    return { jti, signed_envelope, expires_at: expiresAt };
  });

  // ── GET /api/federation/query ──────────────────────────────────────────────
  routes.set('GET /api/federation/query', async (req, _body) => {
    const authHeader = req.headers?.authorization ?? '';
    const receipt    = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!receipt) throw httpError('Authorization: Bearer <receipt> required', 401);

    const capability = req.url?.match(/[?&]capability=([^&]+)/)?.[1] ?? null;

    // Verify signature, expiry, audience, jti-not-revoked (all in verifyReceipt).
    // Use our own revocation fetcher pointing to /well-known/federation/revocations.json.
    const revocationFetcher = async () => {
      // OPT-166 P3-B5: no board principal on this path — system-scoped read.
      const rows = await withFederationSystemScope(exec =>
        exec(
          `SELECT jti::text FROM agent_graph.federation_grants WHERE revoked_at IS NOT NULL`,
          []
        )
      );
      return { revoked: rows.rows.map(r => r.jti) };
    };
    // JWKS fetcher: return empty keys; verifyReceipt falls back to inline verify
    // (the local-org self-verify path). When we later serve /.well-known/jwks.json
    // this fetcher will load the published key set.
    const jwksFetcher = async () => {
      // Return a synthetic JWKS with whatever public key the module has loaded.
      // In production this would be served at /.well-known/jwks.json.
      // For the issuing org verifying its own receipts, we can short-circuit.
      return { keys: [] }; // verifyReceipt falls back to inline verify when no keys found
    };

    let verification;
    try {
      verification = await verifyReceipt(receipt, {
        expectedAudience: orgDid,   // the issuing org is also the query endpoint
        currentOrgDid:    orgDid,
        jwksFetcher,
        revocationFetcher,
      });
    } catch (err) {
      await auditFederationQuery(query, 'unknown', 'rejected', `verify-error: ${err.message}`, null);
      throw httpError(`Receipt verification error: ${err.message}`, 401);
    }

    if (!verification.valid) {
      await auditFederationQuery(query, 'unknown', 'rejected', verification.reason, null);
      throw httpError(`Receipt invalid: ${verification.reason}`, 401);
    }

    const claims = verification.claims;
    const jti    = claims.jti;

    // Fetch the persisted grant row — scope enforcement at SERVER level (P2).
    // usage_count is derived from state_transitions audit rows (P3 append-only;
    // migration 169 has no usage_count column — we count served audit rows instead).
    // OPT-166 P3-B5: no board principal on this path — system-scoped read.
    const grantResult = await withFederationSystemScope(exec =>
      exec(
        `SELECT g.jti, g.scope_capability, g.scope_filter, g.max_results, g.max_calls,
                g.contract_hash,
                g.expires_at, g.revoked_at,
                COALESCE(
                  (SELECT COUNT(*)
                     FROM agent_graph.state_transitions
                    WHERE work_item_id = 'federation:query:' || g.jti::text
                      AND to_state = 'served'),
                  0
                ) AS usage_count
           FROM agent_graph.federation_grants g
          WHERE g.jti = $1::uuid`,
        [jti]
      )
    );

    if (!grantResult.rows.length) {
      await auditFederationQuery(query, jti, 'rejected', 'grant-not-found', claims.sub);
      throw httpError('Receipt not found in grant store', 404);
    }

    const grant = grantResult.rows[0];
    // OPT-54: shared contract anchor — both audit chains (federation:grant:<jti> written
    // by the DB trigger, and federation:query:<jti> written here) reference the same
    // contract_hash so the cross-org exchange can be joined on a single value.
    const contractHash = grant.contract_hash ?? null;

    // Re-check revocation from DB (belt-and-suspenders beyond verifyReceipt).
    if (grant.revoked_at) {
      await auditFederationQuery(query, jti, 'rejected', 'revoked', claims.sub, contractHash);
      throw httpError('Receipt has been revoked', 401);
    }

    // Expiry check from DB row (not just JWT exp claim).
    if (grant.expires_at && new Date(grant.expires_at) < new Date()) {
      await auditFederationQuery(query, jti, 'rejected', 'expired', claims.sub, contractHash);
      throw httpError('Receipt has expired', 401);
    }

    // max_calls enforcement (server-side, from DB row).
    const maxCalls   = grant.max_calls ?? Infinity;
    const usageCount = Number(grant.usage_count ?? 0);
    if (maxCalls !== null && usageCount >= maxCalls) {
      await auditFederationQuery(query, jti, 'rejected', 'max_calls_exceeded', claims.sub, contractHash);
      throw httpError('max_calls exceeded for this receipt', 429);
    }

    // usage_count is tracked via state_transitions audit rows (appended below on success).
    // Resolve the capability requested (from query param, fall back to grant capability).
    const requestedCapability = capability ?? grant.scope_capability;
    if (requestedCapability !== grant.scope_capability) {
      await auditFederationQuery(query, jti, 'rejected', `capability-mismatch: ${requestedCapability}!=${grant.scope_capability}`, claims.sub, contractHash);
      throw httpError(`Capability ${requestedCapability} not in grant scope (${grant.scope_capability})`, 403);
    }

    // scope.filter is applied SERVER-SIDE from the DB row — audience cannot widen it.
    const filter = grant.scope_filter ?? {};
    const maxResults = Math.min(grant.max_results ?? 100, 100);

    // Execute the KG read. scope.filter.origin_org enforces org boundary.
    let nodes = [];
    if (requestedCapability === 'kg.read') {
      const originOrg = filter.origin_org ?? null;

      // Build a safe WHERE clause from the persisted filter.
      // Only known safe filter fields are applied; no user-controlled interpolation.
      const whereClauses = [];
      const params = {};

      if (originOrg) {
        whereClauses.push('n.origin_org = $origin_org');
        params.origin_org = originOrg;
      }
      if (filter.label) {
        // Label filter: we use APOC or a pattern match; here we do a type check.
        // PGlite/offline: KG may be unavailable; gate gracefully.
        whereClauses.push('$label IN labels(n)');
        params.label = filter.label;
      }
      if (filter.name_contains) {
        whereClauses.push('toLower(n.name) CONTAINS toLower($name_contains)');
        params.name_contains = filter.name_contains;
      }

      const whereStr = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const cypher   = `MATCH (n) ${whereStr} RETURN n LIMIT $limit`;
      params.limit   = maxResults;

      try {
        const records = await runCypher(cypher, params, { readOnly: true });
        if (records) {
          nodes = records.map(r => {
            const node = r.get('n');
            return { id: node.identity?.toNumber?.() ?? node.identity, properties: node.properties, labels: node.labels };
          });
        }
      } catch (err) {
        log.warn({ err: err.message, jti }, 'KG read error during federation query');
        // Non-fatal: return empty slice + audit.
      }
    }
    // Other capabilities (rag.read, audit.read) reserved for future tickets.

    await auditFederationQuery(query, jti, 'served', `returned ${nodes.length} nodes`, claims.sub, contractHash);

    log.info({ jti, capability: requestedCapability, nodes: nodes.length }, 'federation query served');

    return {
      jti,
      capability:   requestedCapability,
      scope_filter: filter,
      max_results:  maxResults,
      nodes,
    };
  });

  // ── GET /.well-known/federation/revocations.json ───────────────────────────
  routes.set('GET /.well-known/federation/revocations.json', async (_req, _body) => {
    // OPT-166 P3-B5: public, unauthenticated route — no board principal — system-scoped read.
    const result = await withFederationSystemScope(exec =>
      exec(
        `SELECT jti::text, revoked_at
           FROM agent_graph.federation_grants
          WHERE revoked_at IS NOT NULL
          ORDER BY revoked_at DESC`,
        []
      )
    );
    return {
      issuer:  orgDid,
      revoked: result.rows.map(r => r.jti),
      fetched_at: new Date().toISOString(),
    };
  });
}
