# Delphi Audit — Board Workstation Session 2
Date: 2026-04-03

Six feedback items. Each section covers design decision, exact implementation pattern, and implementation notes for CompliantImplementer.

---

## 1. Agent Hub — Nav Consolidation

### Current State
SideNav has Graph under "Data" and Activity/Runs/Agents scattered across groups. Four separate pages. No unified entry point for agent-related work.

### Design Decision: Single Hub Route with Segment Tabs

Route: `/agents` becomes the hub. Sub-views as URL segments: `/agents` (graph), `/agents/config`, `/agents/runs`, `/agents/activity`.

Navigation pattern: **horizontal pill-toggle tabs** pinned below the page header, not a secondary sidebar. Rationale: the content area is wide (3-panel layout), secondary sidebars eat horizontal space. Pill tabs are scannable, match the existing pill badge language, and work at any viewport width.

```
[Graph]  [Config]  [Runs]  [Activity]
```

Tab state lives in the URL (Next.js layout + `useSelectedLayoutSegment()`), not React state. This gives deep-linkability and browser-back behavior for free.

**SideNav change**: Remove Graph from "Data", remove Activity from "System", remove Runs from "Control". Replace with a single "Agents" entry pointing to `/agents`. The Agents group in SideNav already exists — just expand it to be the sole entry for all four views.

**Tab component spec:**
```tsx
// Tailwind classes for tab strip
<nav className="flex gap-1 px-4 py-2 border-b border-white/5 bg-zinc-950 sticky top-[49px] z-10">
  <TabLink href="/agents" exact>Graph</TabLink>
  <TabLink href="/agents/config">Config</TabLink>
  <TabLink href="/agents/runs">Runs</TabLink>
  <TabLink href="/agents/activity">Activity</TabLink>
</nav>

// Active state
"px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
// Inactive: "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
// Active:   "bg-white/10 text-zinc-100"
```

The `/agents` layout.tsx wraps all four segments. Graph is the default (`page.tsx`). The three other segments move from their current routes — no new components, only route migration.

---

## 2. Agent Detail Panel from Graph

### Current State
`InspectorPanel` exists in `SystemGraph.tsx` but only shows surface-level data on node click. The full agent detail page at `/agents/[id]` has model, config, edit. These are disconnected.

### Design Decision: Right Slide-Over Panel (Preserves Graph Context)

Do not navigate away from the graph. Clicking a node opens a slide-over from the right edge that overlays the graph. The graph remains visible and pannable behind the panel. This is the canonical pattern for "detail without losing context" — used by Linear, Vercel, and Figma for exactly this use case.

Panel width: `w-[420px]` fixed. The panel sits inside the 3-panel layout's center column, not the right chat rail — the chat rail is already occupied. Use an absolutely-positioned overlay within the graph container (`relative` on the graph wrapper).

**Transition spec:**
```
enter: translate-x-full → translate-x-0, opacity 0 → 1
duration: 280ms
easing: cubic-bezier(0, 0, 0.2, 1)  // deceleration — content entering from outside
prefers-reduced-motion: skip translate, fade only at 150ms
```

**Panel sections** (same data as `/agents/[id]`):
1. Header: agent initials avatar, display name, tier badge, online pulse dot
2. Model & Cost: model key, provider badge, input/output cost per 1M, context window
3. Config: temperature slider (read), maxTokens, enabled toggle (inline edit)
4. Tools & Capabilities: full tag list (not truncated to 4)
5. Recent Activity: last 5 tasks (title, status, timestamp) — fetched from `/api/agents/status` extended payload
6. Quick Actions: Enable/Disable toggle, "Edit Config" button that focuses the Config tab in the hub

Close: X button top-right, Escape key, click-outside the panel (not the graph background — graph panning should not close it; use a transparent overlay layer with pointer-events-none behind the panel but above the graph, with explicit close button only).

**Node click wiring** (already exists in `SystemGraph.tsx` as `onNodeClick`):
```tsx
const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
  if (node.type === "agent") {
    setSelectedAgent((node.data as AgentNodeData).agentId);
  }
}, []);
```
`selectedAgent` state drives the slide-over visibility.

---

## 3. Graph Node Position Persistence

### Current State
Dagre auto-layout runs on every mount. Dragged positions snap back on refresh. `useNodesState` holds positions in memory only.

### Design Decision: localStorage with Per-View Key

React Flow provides a controlled position model. When a node is dragged, `onNodeDragStop` fires with the final position. Write to localStorage. On mount, after dagre layout runs, merge any saved positions over the auto-layout positions.

```tsx
const POSITION_KEY = "optimus:graph:positions:unified"; // one key per ViewMode

// On mount, after building nodes:
const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "{}");
const mergedNodes = builtNodes.map(n => ({
  ...n,
  position: saved[n.id] ?? n.position,
}));

// On drag stop:
const onNodeDragStop: NodeMouseHandler = useCallback((_, node) => {
  const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "{}");
  saved[node.id] = node.position;
  localStorage.setItem(POSITION_KEY, JSON.stringify(saved));
}, []);
```

Add a "Reset Layout" button to the graph Panel (top-right) that clears the localStorage key and re-runs dagre. This solves the case where new agents are added and the saved layout becomes stale.

```tsx
// Reset button placement — use React Flow's Panel component, already imported
<Panel position="top-right">
  <button
    onClick={() => { localStorage.removeItem(POSITION_KEY); load(); }}
    className="px-2.5 py-1 text-xs bg-zinc-800/90 text-zinc-400 rounded border border-white/10 hover:text-zinc-200 hover:bg-zinc-700 transition-colors backdrop-blur"
  >
    Reset Layout
  </button>
</Panel>
```

Keys per view: `optimus:graph:positions:unified`, `optimus:graph:positions:agents`, etc. — one per `ViewMode` string.

---

## 4. Model Selection UX — OpenRouter Rankings

### Current State
Model picker in agent edit is a plain `<select>` with raw model keys. No pricing context. No capability scores. No way to compare without leaving the page.

### Design Decision: Command-Palette-Style Model Picker with Comparison Card

Replace the `<select>` with a button that opens a floating popover. The popover contains:

1. **Search input** — filter models by name or capability tag
2. **Model list** — each row shows: model name, provider badge, input/output cost, and 3 score pills (Programming, Reasoning, Context). Selected model has a checkmark and highlighted row.
3. **Hover/focus → detail card** — hovering a model row (or focusing via keyboard) reveals an inline detail panel to the right of the list. Shows: full model ID, context window, max output, category scores as mini bar charts, a "Best for: [role]" recommendation label derived from agent tier.

The popover is not a modal. It sits as an absolute-positioned panel below the trigger button, z-50, with `backdrop-blur-sm bg-zinc-900/95 border border-white/10 rounded-xl shadow-2xl`. Width: `w-[540px]` (list 260px + detail card 260px with a divider).

**Score data source:** OpenRouter's `/api/models` endpoint returns `per_request_limits` and category metadata. The existing `/agents/models` page already fetches from this — extend the API route to return `capabilities` scores. Cache in the models config or a separate endpoint. Do not call OpenRouter client-side from the board.

**Best model suggestion label per tier:**
- orchestrator/core → "Recommended: strong reasoning, low latency"
- executor/* → "Recommended: fast, low cost"
- reviewer/core → "Recommended: high accuracy, code-capable"
- architect/* → "Recommended: long context, deep reasoning"
- external/* → "Recommended: max reasoning"

These labels derive from the agent's `tier` + `subTier` fields already present in config — no new data needed.

**Trigger button** (replaces `<select>`):
```tsx
<button className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 border border-white/10 rounded-lg text-xs text-zinc-200 hover:bg-zinc-700 transition-colors min-w-[200px] justify-between">
  <span className="font-mono truncate">{currentModel}</span>
  <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" /* chevron-down */ />
</button>
```

Keyboard: arrow keys navigate list, Enter selects, Escape closes. Matches `combobox` ARIA pattern — use `role="combobox"` on the trigger, `role="listbox"` on the list, `role="option"` on each row, `aria-activedescendant` for keyboard focus tracking.

---

## 5. Campaign Notifications — Success + Failure

### Current State
Only failure notifications reach the board. Success is silent.

### Design Decision: Semantic Toast Pair

This is the simplest of the six items. The notification system (wherever campaign status events are emitted — likely via `pg_notify` → SSE → board) needs to emit two event types. The board already has a toast pattern (`fixed top-16 right-6`).

**Success toast:**
```
bg-emerald-950 border border-emerald-500/30 text-emerald-100
Icon: checkmark circle, emerald-400
Title: "Campaign Complete"
Body: "{campaign name} finished — {N} steps completed"
Auto-dismiss: 6s
```

**Failure toast (updated to match semantic system):**
```
bg-red-950 border border-red-500/30 text-red-100
Icon: X circle, red-400
Title: "Campaign Failed"
Body: "{campaign name} stopped at step {N} — {error summary}"
Action button: "View" → navigates to /campaigns/{id}
Auto-dismiss: never (failure requires acknowledgment)
```

Both toasts should stack (not replace each other) if multiple campaigns complete simultaneously. Use a toasts array in state rather than a single toast slot, keyed by campaign ID.

The toast position should move to **bottom-right** for this product — top-right conflicts with the sticky header and tab navigation. Bottom-right is the 2025 convention and avoids overlap with any header-level status indicators.

```
fixed bottom-6 right-6 z-50 flex flex-col gap-2
```

---

## 6. Research Agent in Knowledge Base — New Tabs

### Current State
`/knowledge-base` has documents and a wiki graph view. No way to manage research agents or schedules.

### Design Decision: Tab-Based Extension of Knowledge Base

Same pill-toggle tab pattern as the Agents hub. Add two tabs to the existing KB header:

```
[Documents]  [Wiki Graph]  [Research Agents]  [Research Schedule]
```

Existing content moves under Documents and Wiki Graph tabs. This avoids adding a new nav item — KB is the right semantic home for research agents since they exist to populate the KB.

### Research Agents Tab

Card grid layout. Each card represents one research agent configuration:

```tsx
// Card structure
<div className="bg-zinc-900 border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors">
  <div className="flex items-start justify-between mb-3">
    <div>
      <h3 className="text-sm font-medium text-zinc-200">{agent.name}</h3>
      <p className="text-xs text-zinc-500 mt-0.5">{agent.description}</p>
    </div>
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${agent.active ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-700 text-zinc-400"}`}>
      {agent.active ? "Active" : "Paused"}
    </span>
  </div>
  {/* Skills as tags */}
  <div className="flex flex-wrap gap-1 mb-3">
    {agent.skills.map(s => (
      <span key={s} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20">{s}</span>
    ))}
  </div>
  {/* Last run + doc count */}
  <div className="flex items-center justify-between text-xs text-zinc-600">
    <span>Last run: {formatRelative(agent.lastRun)}</span>
    <span>{agent.docCount} docs ingested</span>
  </div>
</div>
```

"+ New Research Agent" button top-right of the tab opens a slide-over (same pattern as agent detail). Fields: name, description, skills (multi-select from predefined list), output format (summary / full doc / structured), target KB source tag.

### Research Schedule Tab

**Table view**, not calendar or kanban. Rationale: research jobs are cron-based, not time-slot events. A calendar implies you care about which hour of day visually. A table is scannable, sortable, and actionable.

Columns: Agent Name | Schedule (human-readable cron: "Every Monday 9am") | Next Run | Status | Last Result | Actions

```tsx
// Status pill variants
"bg-emerald-500/15 text-emerald-400"  // completed
"bg-blue-500/15 text-blue-400"        // running
"bg-yellow-500/15 text-yellow-400"    // scheduled
"bg-red-500/15 text-red-400"          // failed
"bg-zinc-700 text-zinc-500"           // paused
```

Inline "Run Now" button in the Actions column. Toggle switch for pause/resume. Clicking a row expands an inline detail showing the last run's output summary and any error if failed.

Cron expression editor: on edit, show a `cronstrue` human-readable translation below the input field in real-time (`npm install cronstrue` — lightweight, no backend required, pure string translation).

---

## Implementation Priority Order

1. Graph position persistence (30 min, self-contained, immediate quality win)
2. Campaign success notifications (1h, clear scope, fills missing functionality)
3. Agent detail slide-over from graph (half-day, highest Dustin impact, drives nav consolidation decision)
4. Nav consolidation + tab pattern (half-day, after slide-over confirms graph as hub)
5. Model selection UX (1 day, depends on OpenRouter scores API extension)
6. Research agent KB tabs (1 day, new feature, lowest urgency)

Items 1 and 2 can ship independently. Items 3 and 4 should ship together.
