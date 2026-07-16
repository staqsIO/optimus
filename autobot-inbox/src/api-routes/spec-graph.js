import { isGraphAvailable } from '../graph/client.js';
import {
  getSpecImpact,
  getAgentSpecContext,
  getSpecCrossRefs,
  getSpecImplementationStatus,
} from '../graph/spec-queries.js';
import { seedSpecGraph } from '../graph/spec-seed.js';

/**
 * Spec Graph API routes.
 *
 * GET  /api/spec-graph/impact?section=N     — impact analysis for §N
 * GET  /api/spec-graph/agent-context?agent=X — spec context for agent X
 * GET  /api/spec-graph/cross-refs?section=N  — cross-references for §N
 * GET  /api/spec-graph/status                — implementation status per section
 * POST /api/spec-graph/reseed                — re-seed spec graph (idempotent)
 */
export function registerSpecGraphRoutes(routes) {

  routes.set('GET /api/spec-graph/impact', async (req) => {
    if (!isGraphAvailable()) {
      return { status: 503, body: { error: 'Neo4j unavailable' } };
    }
    const url = new URL(req.url, 'http://localhost');
    const section = url.searchParams.get('section');
    if (!section) {
      return { status: 400, body: { error: 'section parameter required' } };
    }
    const result = await getSpecImpact(section);
    return { status: 200, body: result || { error: 'Section not found' } };
  });

  routes.set('GET /api/spec-graph/agent-context', async (req) => {
    if (!isGraphAvailable()) {
      return { status: 503, body: { error: 'Neo4j unavailable' } };
    }
    const url = new URL(req.url, 'http://localhost');
    const agent = url.searchParams.get('agent');
    if (!agent) {
      return { status: 400, body: { error: 'agent parameter required' } };
    }
    const result = await getAgentSpecContext(agent);
    return { status: 200, body: result || { error: 'Agent not found' } };
  });

  routes.set('GET /api/spec-graph/cross-refs', async (req) => {
    if (!isGraphAvailable()) {
      return { status: 503, body: { error: 'Neo4j unavailable' } };
    }
    const url = new URL(req.url, 'http://localhost');
    const section = url.searchParams.get('section');
    if (!section) {
      return { status: 400, body: { error: 'section parameter required' } };
    }
    const result = await getSpecCrossRefs(section);
    return { status: 200, body: result || { error: 'Section not found' } };
  });

  routes.set('GET /api/spec-graph/status', async () => {
    if (!isGraphAvailable()) {
      return { status: 503, body: { error: 'Neo4j unavailable' } };
    }
    const result = await getSpecImplementationStatus();
    return { status: 200, body: result || [] };
  });

  routes.set('POST /api/spec-graph/reseed', async () => {
    if (!isGraphAvailable()) {
      return { status: 503, body: { error: 'Neo4j unavailable' } };
    }
    const start = performance.now();
    await seedSpecGraph();
    const durationMs = Math.round(performance.now() - start);
    return { status: 200, body: { ok: true, durationMs } };
  });
}
