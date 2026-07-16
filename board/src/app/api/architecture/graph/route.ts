import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import graph from "@/data/architecture/knowledge-graph.json";

/**
 * OPT-88 / feature-001 — auth-gated code-architecture graph.
 *
 * Serves the Understand-Anything knowledge graph (a code-architecture map of the
 * optimus repo) to the vendored dashboard at /architecture-app/. That bundle is
 * built with VITE_GRAPH_URL=/api/architecture/graph and fetches this same-origin,
 * so the board's NextAuth session cookie is sent automatically. This handler is a
 * second, server-side gate (P1 defense-in-depth) on top of the global
 * next-auth middleware.
 *
 * The data is a build-time-vendored file (src/data/architecture/knowledge-graph.json)
 * imported here, so it is BAKED INTO THE SERVER BUNDLE AT `next build`. The refresh
 * script (scripts/refresh-architecture-graph.mjs) only rewrites that file on disk —
 * a `next build` + redeploy is required for a refreshed graph to go live. Swap in
 * the real optimus graph by running `/understand` in the repo, then
 * `npm --prefix board run graph:refresh`, then rebuild/deploy.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(graph, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
