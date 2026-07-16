// Canonical route module name for source-search ingestion.
// Backward compatibility: reuse existing feed route registration logic.
import { registerFeedRoutes } from './feeds.js';

export function registerResearchSourceRoutes(routes, opts = {}) {
  // STAQPRO-608 r2a: pass { withViewer } through so feeds.js can org-scope the
  // GET /api/feeds/subscriptions (and /api/research-sources/subscriptions) read.
  return registerFeedRoutes(routes, opts);
}

// Keep old symbol available for compatibility.
export { registerFeedRoutes };
