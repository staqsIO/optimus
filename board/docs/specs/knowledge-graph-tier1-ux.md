# Knowledge Graph — Tier 1 (Entity Lens) UX Spec

**Route:** `/graph`  
**Component:** `KnowledgeGraph.tsx`  
**Status:** Replaces the current redirect to `/agents?tab=graph`  
**Version:** 1.0 — 2026-05-11

---

## 1. Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  TOPBAR (full width, 52px)                                           │
│  [← Board]  [Entity search autocomplete ____________▼]  [⏱ 7d ▾]   │
├───────────────────────────────────────────────┬─────────────────────┤
│                                               │                     │
│  CANVAS  (flex-1, @xyflow/react)              │  INSPECTOR PANEL    │
│                                               │  (360px, slide in)  │
│  • Force-directed layout                      │                     │
│  • Focused entity = large center node         │  [Entity name]      │
│  • 1-hop neighbors = medium ring nodes        │  [Type badge]       │
│  • Edge labels on hover only                  │  [Strength bar]     │
│                                               │                     │
│  [Zoom in] [Zoom out] [Fit view]              │  SUMMARY            │
│                 (bottom-left, 44×44px each)   │  ─────────────────  │
│                                               │  RAG-synthesized    │
│                                               │  paragraph          │
│                                               │                     │
│                                               │  THREADS (last 5)   │
│                                               │  ─────────────────  │
│                                               │  • Subject — age    │
│                                               │  • Subject — age    │
│                                               │                     │
│                                               │  CONNECTIONS        │
│                                               │  ─────────────────  │
│                                               │  Person  ●●●●● 82   │
│                                               │  Person  ●●●●○ 67   │
│                                               │                     │
│                                               │  [→ View contact]   │
│                                               │  [→ Search threads] │
└───────────────────────────────────────────────┴─────────────────────┘
```

**Responsive — tablet (< 1024px):** Inspector becomes a bottom sheet (50vh, drag-to-dismiss). Canvas takes full width. Topbar search collapses to an icon that opens a modal search.

---

## 2. Node Visual Encoding

| Entity type | Shape | Fill | Icon |
|---|---|---|---|
| Person | Circle | `zinc-800` + `indigo-500` ring | Initials monogram |
| Organization | Rounded rect | `zinc-800` + `violet-500` ring | Building glyph |
| Topic | Pill | `zinc-800` + `amber-500` ring | Tag glyph |
| Focused entity | Any of above | ring-width 3px, scale 1.25 | same |

**New-in-7d badge:** Small emerald dot (8px) at top-right of node. Rendered as an SVG circle, not only color — includes `aria-label="new in last 7 days"`.

**Edge encoding:**

| Relationship | Line style | Weight |
|---|---|---|
| `PARTICIPATED_WITH` | Solid | proportional to strength score (1–4px) |
| `COLLABORATED_ON_PROJECT` | Dashed | fixed 2px |
| `MEMBER_OF` | Dotted | fixed 1px |
| `MENTIONED` | Solid faint | fixed 1px, 40% opacity |
| `ATTENDED` | Solid faint | fixed 1px, 40% opacity |

Edge color is always `zinc-600`. Strength is encoded in line weight only, not hue — color alone is never the sole signal.

---

## 3. Interaction Patterns

### Search / Focus

1. User types in the topbar autocomplete. Debounce 200ms. Results fetch from `GET /api/graph/entity/search?q=`.
2. Selecting a result sets the focused entity: URL updates, graph re-fetches, canvas re-centers (animated, 400ms ease-out).
3. Keyboard: `↑`/`↓` to navigate results, `Enter` to select, `Escape` to close.

### Node interactions

- **Click** — selects node, opens Inspector Panel. URL `?selected=<id>` updates. Does not re-center canvas.
- **Double-click** — re-focuses the entire graph on that entity (re-fetches subgraph, URL `?entity=<id>` updates).
- **Hover** — node scales to 1.05× (150ms, `cubic-bezier(0.4, 0, 0.2, 1)`), edge labels appear inline. Tooltip shows entity name + type if label is truncated.
- **Escape** — deselects node, closes Inspector.

### Inspector Panel

- Opens as right-side panel (360px). Canvas animates from `w-full` to `w-[calc(100%-360px)]` (200ms ease-in-out). Mirrors the `SystemGraph.tsx` pattern exactly.
- Close: `×` button (top-right, `aria-label="Close inspector"`), or `Escape`, or clicking canvas background.
- Inspector props: `{ entity: EntityNode; onClose: () => void }` — same shape as `InspectorPanel.tsx` `{ node, onClose }`.

### Recency filter

- Dropdown in topbar: "All time" | "Last 7 days" | "Last 30 days". Defaults to "All time".
- "Last 7 days" dims nodes with no recent activity to 30% opacity and adds the emerald badge to active ones.
- URL param: `?since=7d` | `?since=30d`.

### Zoom controls

- Three icon buttons, bottom-left canvas, each 44×44px, `aria-label` set explicitly.
- Keyboard: `+`/`-` for zoom, `0` for fit-view, `F` to re-center on focused entity.

---

## 4. URL State

All view state is encoded in search params so any view is deep-linkable and browser-back works correctly.

| Param | Type | Meaning |
|---|---|---|
| `entity` | string (UUID) | The focused entity — drives API call |
| `selected` | string (UUID) | Node with Inspector open |
| `since` | `7d` \| `30d` \| absent | Recency filter |
| `layout` | absent (reserved) | Future: alternate layouts |

Example: `/graph?entity=org_abc123&selected=person_xyz&since=7d`

On mount: if `entity` param absent, show the empty/landing state (see §6). If `entity` present but fetch fails, show error state.

---

## 5. API Contract

### `GET /api/graph/entity/[id]`

Query params: `since` (optional, `7d` | `30d`)

Response shape (matches `@xyflow/react` node/edge format):

```ts
{
  focus: {
    id: string;
    type: "person" | "organization" | "topic";
    label: string;
    data: { initials?: string; recentActivity: boolean; }
  };
  nodes: ReactFlowNode[];   // focus node + 1-hop neighbors
  edges: ReactFlowEdge[];   // typed, include `strength: number` in data
  inspector: {
    summary: string | null;           // RAG-synthesized, may be null
    threads: { subject: string; threadId: string; age: string }[];  // last 5
    connections: { id: string; label: string; strength: number }[]; // top 5, sorted desc
  }
}
```

### `GET /api/graph/entity/search?q=`

Response: `{ results: { id: string; label: string; type: string }[] }` — max 8 results.

---

## 6. States

### Empty / Landing (no `entity` param)

Center-canvas message:
```
[Graph icon, 48px, zinc-600]
  Search for an entity above
  to explore what Optimus knows about it
```
No skeleton. No spinner. Static illustration.

### Loading (entity param present, fetch in flight)

- Canvas: three placeholder nodes (gray shimmer circles) in a triangle, two placeholder edges. Shimmer via `animate-pulse`.
- Inspector: full-height shimmer bars (3 lines heading, 4 lines body).
- Topbar search: disabled, cursor `wait`.

### Error (fetch failed)

- Canvas shows a centered inline error card (not full-page takeover):
  ```
  Could not load graph for this entity.
  [Try again]   [← Clear search]
  ```
- Inspector does not open.
- Error is announced to screen readers via `role="alert"`.

### Sparse (entity exists, 0 connections)

- Canvas shows single focused node, no edges.
- Inspector opens normally with whatever data exists.
- Below the Connections section: `"No connections found yet. Connections appear as Optimus processes related threads."` — plain text, zinc-500, no icon needed.

---

## 7. Visual Hierarchy (The Demo Question)

First 10 seconds must read as: "It knows this entity and who it's connected to."

Priority order for the eye:
1. **Focused entity** — center-positioned, larger, full-color ring. The eye lands here first.
2. **Connection density** — the ring of neighbor nodes communicates "how much does the system know?" at a glance. More nodes = richer data.
3. **Inspector summary** — the RAG paragraph is the plain-language answer to "what does it know?" Shown at top of panel, no truncation, no "show more" for Tier 1.
4. **Recent threads** — the "evidence trail" that makes the summary credible. Subject lines + age.
5. **Strength bars** — renders relationship quality as pill-dots (`●●●●○`) rather than a raw number. Five dots, filled proportionally to the 0–100 score in 20-point increments.

---

## 8. Accessibility

- All interactive elements reachable via `Tab`. Focus order: topbar search → recency filter → canvas → zoom controls. Inspector panel traps focus when open (focus returns to triggering node on close).
- Canvas nodes are rendered in an `<svg>` with `role="listitem"` per node inside a `role="list"` wrapper. Each node has `aria-label="{label}, {type}, {N} connections"`.
- Edges: decorative, `aria-hidden="true"`.
- Strength dots: `aria-label="Relationship strength: {score} out of 100"` on the container, not on individual dots.
- Color contrast: zinc-200 text on zinc-800 node backgrounds = 8.5:1. Emerald-400 badge on zinc-800 = 4.6:1. Both pass WCAG 2.2 AA.
- Motion: node-focus transition and panel slide wrapped in `@media (prefers-reduced-motion: reduce)` — replaced with instant swap when motion is reduced.
- `Escape` closes Inspector and returns focus to previously focused node.

---

## 9. Build List Mapping

| # | Deliverable | Notes |
|---|---|---|
| 1 | `KnowledgeGraph.tsx` | Wraps `@xyflow/react`, owns canvas + node/edge render |
| 2 | `GET /api/graph/entity/[id]` | Returns nodes + edges + inspector bundle in one call |
| 3 | `EntitySearch` autocomplete | Topbar component, calls `/api/graph/entity/search` |
| 4 | `EntityInspectorPanel.tsx` | Clone of `InspectorPanel.tsx`; props `{ entity, onClose }` |
| 5 | Recency filter dropdown | Stateless; passes `since` to parent, reflected in URL |
| 6 | `/graph/page.tsx` | Remove redirect; render `KnowledgeGraph.tsx` with URL-param wiring |

Tier 2 (live agent overlay), Tier 3 (provenance subgraph), and Tier 4 (time scrub) should be considered when deciding panel DOM structure — leave an extension slot at the bottom of `EntityInspectorPanel` rather than hardcoding section count.
