# 001 — Architecture Knowledge Graph in the Board Workstation

| | |
|---|---|
| **Status** | Draft (pending board review) |
| **Author** | Claude (for Dustin) |
| **Created** | 2026-05-31 |
| **Surface** | Board Workstation (`board/`, port 3200, board.staqs.io) — PRIMARY |
| **Related** | `CLAUDE.md` (artifact hierarchy), `spec/decisions/008-agent-native-governed-operating-layer.md`, Understand-Anything plugin (`/understand`) |

## TL;DR

The `/understand` knowledge graph (a 3,657-node / 5,597-edge map of the optimus codebase — files, functions, layers, a guided tour) is currently only viewable through an ephemeral, localhost-only Vite dev server that dies with the terminal session. Board members cannot see it from board.staqs.io. This feature makes that architecture graph **live with the repo and viewable as an auth-gated page inside the Board Workstation**, by vendoring the Understand-Anything dashboard as a static bundle the board app serves behind its existing NextAuth gate. It does **not** replace the board's existing operational `/graph` view (agent topology + signals), which is a different graph for a different purpose.

## Problem & Motivation

- `/understand` produces `.understand-anything/knowledge-graph.json` — the only structured, navigable map of the *code* architecture (layers, file/function dependency edges, SQL migration lineage, a 15-step guided tour).
- Today it is viewable only via `understand-dashboard`, which starts a Vite dev server bound to `127.0.0.1` with a one-time token. It is not reachable by other board members and is not persisted.
- The Board Workstation already has a `/graph` view, but it renders a **different** graph: `board/src/components/graph/SystemGraph.tsx` builds a curated *operational* graph (live agent topology + spec-section cross-refs + signal flow, ~dozens of nodes) from `board/src/app/api/graph/route.ts`. It is not built for, and cannot ingest, the thousands-of-nodes code knowledge graph.
- Board members (Eric, Dustin) want to explore the system architecture from the dashboard they already use, behind the access control they already trust.

## Goals

- Board members can open the code-architecture knowledge graph from the Board Workstation nav and explore it (layers, search, node inspector, guided tour) without any local setup.
- Access is restricted to authenticated board members via the board's existing auth boundary — no new public surface.
- The graph data lives in / is served by the optimus repo, with a defined, low-friction way to refresh it when the codebase changes.

## Non-Goals

- **Not** replacing or merging with the existing operational `/graph` (`SystemGraph.tsx`). The two graphs coexist; this adds a distinct "Architecture" view.
- **Not** re-implementing the visualization natively in the board's design system for v1 (that is the rejected Option 2 — see "Alternatives").
- **Not** real-time / live graph updates. The graph is a periodically regenerated snapshot.
- **Not** editing the graph from the board.

## Users & Stories

- **As a board member (Eric, Dustin)**, I want to open an "Architecture" page in the Board Workstation and browse the codebase as a layered, navigable graph, so I can understand and reason about the system without cloning the repo or running a local tool.
- **As a board member**, I want to follow the guided tour (governing docs → task graph → guardrails → agent loop → product → Board Workstation → audit layer) so I can onboard to the architecture quickly.
- **As an operator**, I want the graph behind the board's auth gate so the private repo's structure is never exposed publicly.
- **As a developer**, I want a one-command way to regenerate and republish the graph so the view does not silently go stale after large changes.

## Acceptance Criteria

1. A new nav entry (proposed slug `architecture`, "System" group) appears in `board/src/lib/nav-config.ts` for `admin` and `member` roles and routes to a working board page.
2. Visiting the route while unauthenticated redirects to sign-in (inherits `board/src/middleware.ts` + `board/src/lib/next-auth-options.ts` staqsIO-org + board-member allowlist). No graph data is served to unauthenticated requests.
3. The page renders the Understand-Anything visualization loaded from the repo's knowledge graph, including: layer view, node search, node inspector, and the guided tour — at the full ~3.6k-node scale without crashing or unacceptable load time (target initial interactive < 5s on a warm board deploy).
4. The graph payload is served by the board app (not a separate process) and is gated by the same auth as the rest of the board.
5. There is a documented, single-command refresh path (e.g. `pnpm graph:refresh` in `board/` or repo root) that regenerates the graph and updates whatever the board serves, plus docs describing when to run it.
6. The existing `/graph` operational view is unchanged and still reachable.
7. CI passes (CG-1 cross-layer-import ratchet not regressed; board build succeeds).

## Proposed Approach (Option 1 — Vendored Static Embed)

Chosen over native re-implementation because the Understand-Anything dashboard is already purpose-built for large code graphs (layer decomposition, ELK clustering, guided tour, inspector) and rebuilding that is wasted effort (smallest-correct-change principle).

Key components:

1. **Vendored static bundle.** The UA dashboard source lives in the Understand-Anything *plugin* (`packages/dashboard/`), **not** in this repo. Its `build:demo` mode (`VITE_DEMO_MODE` + `VITE_GRAPH_URL`) emits a self-contained static bundle that fetches the graph from a plain URL instead of the token-gated dev server. Vendor that built output into the board app (e.g. `board/public/architecture/`) or wire it as a build step.
2. **Board-served, auth-gated data endpoint.** A board API route (e.g. `board/src/app/api/architecture/graph/route.ts`) serves `knowledge-graph.json` (and `meta.json`) behind the board's auth. Optionally a second route serves repo file contents for the dashboard's code-viewer panel (server-side read of the working tree), also gated.
3. **Board route + nav.** A board page (proposed `board/src/app/architecture/page.tsx`) hosts the vendored bundle (iframe or sub-app mount), and a `PAGE_REGISTRY` + `NAV_BY_ROLE` entry in `nav-config.ts` exposes it.
4. **Refresh pipeline.** A script that re-runs `/understand` analysis (or copies an existing `.understand-anything/knowledge-graph.json`) and updates the served artifact, documented for operators. Consider wiring to `/understand --auto-update` so commits keep it current.

## Constraints

- **Plugin dependency.** The visualization is owned by an external plugin; the repo vendors *built output* + a regen script, not the plugin source. Version drift between the vendored bundle and the plugin must be tracked (record the plugin version in `meta.json` or a `VENDORED.md`).
- **Design principles.** P1 deny-by-default and P2 infrastructure-enforces: data access must be enforced by the board's auth middleware, not by obscurity of the bundle path.
- **Code-viewer fidelity.** The static demo build cannot serve repo file contents on its own; the code-viewer panel only works if the board adds a gated file-content API route (decision below).
- **Payload size.** The graph is ~3 MB JSON; serve gzipped, and lazy-load so it does not bloat the main board bundle.
- **CG-1 ratchet.** Avoid introducing new cross-layer imports that regress `.github/cg1-baseline`.
- **No new public surface / data exposure.** Because the board gate restricts to staqsIO board members, this resolves the private-architecture-exposure concern that rules out a public static host.

## Open Questions (resolve before / during planning)

1. **Where does the graph JSON live?** Committed under `board/public/` (simple, but a 3 MB binary-ish blob in git, stale between regens) vs. served from a board API route reading from a generated location vs. object storage (S3/Railway volume). Recommendation: board API route reading a generated artifact; decide storage.
2. **Is the code-viewer in scope for v1?** If yes, requires the gated file-content API route and a decision on reading from the deployed working tree vs. a snapshot. If no, ship the graph/inspector/tour and defer code view.
3. **Embed mechanism:** iframe the `/architecture/` bundle (fast, isolated, but design-system mismatch and cross-frame auth/token plumbing) vs. mount as a sub-app within the board shell (more integrated, more work).
4. **Refresh trigger:** manual `pnpm graph:refresh`, a CI job on merge to main, or `/understand --auto-update` on commit? Who owns keeping it fresh?
5. **Graph scope:** ship the full monorepo graph, or a board-relevant subset? Full is the current artifact; subsetting is a later optimization.

## Alternatives Considered

- **Option 2 — Native rebuild** of the visualization in the board's `@xyflow/react` stack against a board-served graph. Highest UX fidelity but effectively rebuilds a working product; rejected for v1 on cost/leverage grounds.
- **Option 3 — External hosted static build** (Vercel/Netlify). Rejected: publishes a private repo's full architecture to an external host, and loses the board's auth boundary.
- **Localhost + tunnel / LAN.** Ephemeral and machine-bound; not "living with optimus."

## Decomposition (candidate Linear issues)

A feature spec produces 1–N execution issues. Proposed breakdown:

1. **Vendor + build pipeline** — script to produce the UA `build:demo` bundle and place it where the board serves it; record plugin version.
2. **Auth-gated graph data API** — `board/src/app/api/architecture/graph/route.ts` serving `knowledge-graph.json` + `meta.json` behind NextAuth.
3. **Board route + nav entry** — `board/src/app/architecture/page.tsx` hosting the bundle; `nav-config.ts` registry + role entries; icon.
4. **(Conditional) code-viewer file-content route** — gated server-side file reads, if the code-viewer is in v1 scope.
5. **Refresh path + docs** — `pnpm graph:refresh` (or CI job) and operator docs; Herald/Scribe docs as appropriate.

## Self-Review Checklist

- [x] Problem and motivation are stated independently of the solution.
- [x] User stories have a clear actor and outcome.
- [x] Acceptance criteria are testable and reference real anchors in the codebase.
- [x] Scope and non-goals are explicit.
- [x] Constraints capture the external-plugin dependency, auth boundary, and payload size.
- [x] Open questions are enumerated and assigned to planning, not left implicit.
- [x] Alternatives considered and rejection rationale recorded.
- [x] Decomposition into executable issues is provided.
- [ ] Board review (Eric + Dustin) — pending.
