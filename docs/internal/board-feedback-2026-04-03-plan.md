# Board Feedback Implementation Plan — 2026-04-03

## Priority 1: Nav Consolidation + Agent Detail from Graph

### 1A. Nav Consolidation — Single "Agents" Hub

**Goal:** Merge Graph, Runs, Activity into the Agents section as sub-tabs. Landing = graph view.

**Current state:**
- SideNav has 4 separate items across groups: `/agents` (Agents group), `/graph` (Data group), `/runs` (Control group), `/activity` (System group)
- Each is a full route with its own page component

**Approach:** Tabbed layout within `/agents` route. Keep existing page components as embedded content.

**Files to change:**

1. **`board/src/components/SideNav.tsx`** — Remove `/graph`, `/runs`, `/activity` from their current nav groups. Keep single "Agents" item under Agents group.

2. **`board/src/app/agents/page.tsx`** — Convert to tabbed hub page:
   - Sub-tabs: **Graph** (default), **List**, **Runs**, **Activity**
   - Graph tab = current `/graph` page content (SystemGraph component)
   - List tab = current agents table (existing AgentsPage content)
   - Runs tab = current `/runs` page content
   - Activity tab = current `/activity` page content
   - Tab state persisted in URL search param (`?tab=graph`)
   - Preserve existing `/agents/[id]` detail route unchanged

3. **`board/src/app/agents/layout.tsx`** (new) — Shared layout with tab bar. Children render below tabs.

4. **Routing redirects** — `/graph`, `/runs`, `/activity` should redirect to `/agents?tab=graph`, `/agents?tab=runs`, `/agents?tab=activity` for bookmark compatibility. Use Next.js `redirect()` in their page files, or `next.config.js` redirects.

**Implementation detail — Tab component:**
```tsx
// board/src/components/agents/AgentTabs.tsx
// Tabs: Graph | List | Runs | Activity
// Uses useSearchParams() for tab state
// Each tab lazy-loads existing content component
```

**Extraction needed:** Current page components need to be refactored into reusable content components:
- `board/src/components/agents/AgentListContent.tsx` — extract from current `agents/page.tsx`
- `board/src/components/agents/AgentRunsContent.tsx` — extract from current `runs/page.tsx`
- `board/src/components/agents/AgentActivityContent.tsx` — extract from current `activity/page.tsx`
- Graph already lives in `components/graph/SystemGraph.tsx` — no extraction needed

### 1B. Agent Detail from Graph — Slide-Over Panel

**Goal:** Click agent node in graph view → show full agent detail (model, config, tier, tasks) in side panel.

**Current state:** Graph already has InspectorPanel that shows on node click. It shows: label, tier, model, status, "View Activity"/"View Runs" links, plus dynamic sections from inspector-registry.

**Gap:** InspectorPanel shows metadata but not the full agent detail page content (config editing, hierarchy, prompt, activity stats, recent tasks). The agent detail page (`/agents/[id]`) has all of this.

**Approach:** Enhance InspectorPanel to embed a compact version of agent detail content, OR replace InspectorPanel for agent nodes with a slide-over that loads agent detail data.

**Recommended: Enhanced InspectorPanel with agent detail sections.**

**Files to change:**

1. **`board/src/components/graph/inspector-registry.ts`** — Add new sections for agent nodes:
   - "Configuration" section (model, temp, tokens, enabled — editable inline)
   - "Hierarchy" section (reports to, escalates to, can delegate)
   - "Activity" section (recent tasks, cost stats)
   - "Config Changes" section (changelog for this agent)

2. **`board/src/components/graph/InspectorPanel.tsx`** — Add "Open Full Detail" link to `/agents/[id]` in the header actions area. Current links to Activity/Runs should update to use the new tabbed URLs.

3. **`board/src/components/graph/useInspectorData.ts`** — May need new data fetchers for the agent detail/activity endpoints.

4. **Alternative (simpler, faster):** Add a "View Detail" button that navigates to `/agents/[id]` and scrolls the detail into a right-panel drawer on the agents hub page (split layout: graph left, detail right). This avoids duplicating the detail UI.

**Recommended phasing:**
- Phase A: Make InspectorPanel "View Full Detail" link navigate to `/agents/{id}` (immediate fix)
- Phase B: Add inline config editing + activity summary to InspectorPanel sections

---

## Priority 2: Bug Fix — Model Change Not Persisting

**Root cause analysis:**

The API endpoint at `src/api-routes/agents.js` line 74-150 handles `POST /api/agents/config`. The flow:
1. `loadConfig()` reads `config/agents.json` from disk
2. Applies changes to the in-memory config object
3. `saveConfig()` writes back to disk with `writeFileSync`

**Potential issues:**
- The `model` change validation at line 90-96 checks if the new model key exists in `config.models`. If Dustin selected a model not in the models config, it would throw a 400 error. The frontend might silently fail to show this error.
- The frontend `saveAgent()` function (agents/page.tsx line 134-163) calls `opsPost` and checks `result.ok`, but the error display is a toast that disappears after 4 seconds.
- **Most likely cause:** The `loadConfig()` at line 75 reads from disk each time. If another process (the agent runtime) also writes to `agents.json` concurrently, it could overwrite the board's change. The agent runtime reloads config on startup and when it receives `agent_config_changed` events.
- **Race condition:** The runtime receives `agent_config_changed` pg_notify, reloads config, but might write its own version back.

**Investigation steps:**
1. Check if `config/agents.json` is git-tracked and gets reset on deploys
2. Check if the runner/AgentLoop writes back to `agents.json` on config reload
3. Check the changelog file to verify the write happened
4. Add better error surfacing in the frontend

**Files to investigate:**
- `autobot-inbox/config/agents.json` — check git status
- `lib/runtime/agent-loop.js` or similar — check if it writes config back
- `src/api-routes/agents.js` — add logging

**Fix approach:**
- Ensure `saveConfig` is the only writer
- Add response logging to frontend to surface API errors
- Check if Railway deploy overwrites the file (likely — it would reset to committed version)

**CRITICAL INSIGHT:** On Railway, the filesystem is ephemeral. Any `writeFileSync` to `agents.json` will be lost on the next deploy. The config change endpoint writes to disk, but Railway resets to the git-committed version on every deploy. **This is almost certainly the bug.** The fix is to persist config overrides in the database (Supabase), not on disk.

**Recommended fix:**
1. Create a `agent_graph.agent_config_overrides` table in Postgres
2. `POST /api/agents/config` writes overrides to DB instead of (or in addition to) disk
3. `GET /api/agents/config` reads `agents.json` as base, merges DB overrides on top
4. This makes config changes survive deploys

---

## Priority 3: Graph Node Positions Not Sticky

**Current state:** SystemGraph uses `fitView` on load, and nodes are positioned by the `buildArchitectureGraph`/`buildUnifiedGraph` functions. Dragging triggers `onNodesChange` (from `useNodesState`), which updates positions in React state, but they reset on data refetch (every 30s) because `setNodes(n)` replaces all nodes.

**Fix approach — localStorage:**

1. **`board/src/components/graph/useNodePositions.ts`** (new hook):
   - On node drag end, save `{ [nodeId]: { x, y } }` to localStorage
   - Key: `graph-node-positions-${viewMode}`
   - On graph build, merge saved positions into computed nodes

2. **`board/src/components/graph/SystemGraph.tsx`**:
   - After `builder()` computes nodes, merge saved positions from localStorage
   - Add `onNodeDragStop` handler to persist position
   - Only apply saved position if node still exists in current data

**Files to change:**
- `board/src/components/graph/useNodePositions.ts` (new)
- `board/src/components/graph/SystemGraph.tsx` (add hook + merge logic)

---

## Priority 4: Campaign Success Notifications

**Current state:** `CampaignNotifications.tsx` listens for `campaign_failed` and `campaign_paused` SSE events.

**Fix:** Add `campaign_completed` listener with same pattern.

**Files to change:**

1. **`board/src/components/CampaignNotifications.tsx`**:
   - Add `campaign_completed` SSE listener
   - Green styling variant for success
   - Include quality score, iteration count, link to preview
   - Include "View PR" button if PR URL is in metadata

2. **Backend** — ensure the campaign completion code emits `campaign_completed` event via SSE. Check `agents/claw-campaigner/` or campaign orchestration code for the emit.

**Backend check needed:**
- `agents/claw-campaigner/` — does it emit `campaign_completed` event?
- If not, add `publishEvent('campaign_completed', ...)` at campaign success point

---

## Priority 5: Model Selection Intelligence (OpenRouter Rankings)

**Current state:** Model selector is a plain `<select>` dropdown with model keys from `agents.json`. The backend already has `POST /api/models/sync` that fetches the OpenRouter catalog.

**Approach:**
1. Store OpenRouter model metadata (pricing, rankings, context size) in a `models_catalog` table or in-memory cache
2. In the model selector dropdown, show enriched info: price, category rankings
3. Add a "Suggested Models" section based on agent role (e.g., coding agents → top programming models)

**Files to change:**
- `board/src/app/agents/[id]/page.tsx` — enhanced model selector
- `board/src/components/agents/ModelSelector.tsx` (new) — reusable enriched model picker
- `src/api-routes/agents.js` — cache OpenRouter data, serve via new endpoint

---

## Priority 6-8: Future Items (Deferred)

- **Research Agent Tab in KB** — future scope, needs design
- **Batch Repo Ingestion** — small form enhancement in knowledge-base page
- **Model ranking per role** — tied to Priority 5

---

## Implementation Order

| Step | Item | Effort | Dependency |
|------|------|--------|------------|
| 1 | Extract page components into reusable content components | 2h | None |
| 2 | Build AgentTabs + tabbed agents page | 1h | Step 1 |
| 3 | Update SideNav (remove consolidated items) | 15min | Step 2 |
| 4 | Add redirects for old routes | 15min | Step 2 |
| 5 | Enhance InspectorPanel with agent detail link + inline config | 1h | Step 2 |
| 6 | Investigate model persistence bug (check Railway + runtime writes) | 30min | None |
| 7 | Implement DB-backed config overrides (if confirmed ephemeral FS issue) | 2h | Step 6 |
| 8 | Sticky node positions (localStorage) | 45min | None |
| 9 | Campaign success notifications | 30min | None |
| 10 | Model selection intelligence (OpenRouter enrichment) | 2h | None |

Steps 1-5 form the nav consolidation epic. Steps 6-7 fix the persistence bug. Steps 8-10 are independent.
