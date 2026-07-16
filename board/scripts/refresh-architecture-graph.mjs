#!/usr/bin/env node
/**
 * OPT-88 / feature-001 — refresh the board's vendored code-architecture graph.
 *
 * The Architecture page (`/architecture`) serves
 * `board/src/data/architecture/knowledge-graph.json` behind the board's auth
 * (see src/app/api/architecture/graph/route.ts). That file is produced by the
 * Understand-Anything plugin's `/understand` command, which writes
 * `.understand-anything/knowledge-graph.json` at the repo root.
 *
 * This script copies that generated graph into the board so a `next build`
 * bundles it. Run it after `/understand` (or `/understand --auto-update`).
 *
 *   Usage:
 *     node board/scripts/refresh-architecture-graph.mjs [path/to/knowledge-graph.json]
 *     npm --prefix board run graph:refresh                 # uses repo-root default
 *
 * Default source: <repo-root>/.understand-anything/knowledge-graph.json
 *
 * Refresh ownership (feature-001 open question): for now this is a MANUAL step.
 * A follow-up can wire it to CI-on-merge or `/understand --auto-update`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const dest = join(__dirname, "..", "src", "data", "architecture", "knowledge-graph.json");

const src =
  process.argv[2] || join(repoRoot, ".understand-anything", "knowledge-graph.json");

if (!existsSync(src)) {
  console.error(
    `[refresh-architecture-graph] source not found: ${src}\n` +
      `Run the Understand-Anything plugin first:\n` +
      `  /plugin marketplace add Egonex-AI/Understand-Anything\n` +
      `  /plugin install understand-anything\n` +
      `  /understand   # writes .understand-anything/knowledge-graph.json`,
  );
  process.exit(1);
}

const raw = readFileSync(src, "utf8");
let graph;
try {
  graph = JSON.parse(raw);
} catch (e) {
  console.error(`[refresh-architecture-graph] source is not valid JSON: ${e.message}`);
  process.exit(1);
}

// Minimal schema sanity — the dashboard requires nodes + edges arrays.
if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
  console.error(
    `[refresh-architecture-graph] unexpected shape: expected { nodes: [], edges: [] }, ` +
      `got keys [${Object.keys(graph).join(", ")}]`,
  );
  process.exit(1);
}

writeFileSync(dest, JSON.stringify(graph, null, 2), "utf8");
console.log(
  `[refresh-architecture-graph] wrote ${graph.nodes.length} nodes / ${graph.edges.length} edges → ${dest}`,
);
