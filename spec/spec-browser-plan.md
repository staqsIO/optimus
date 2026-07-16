# Spec Browser Implementation Plan

## Decision: Dedicated `/spec` page, not expanded panel

The SpecReferencePanel is a Workstation sidebar tool — it serves inline reference during prompt-to-PR work. A full spec browsing and amendment experience warrants a separate page, analogous to how `/governance` is separate from the Workstation. The panel stays as-is; the new page is the canonical spec reading surface.

Add a "SPEC" link to NavBar, between Workstation and Governance.

---

## Route: `/spec`

`dashboard/src/app/spec/page.tsx`

Three-column layout (same spatial grammar as the rest of the dashboard):

```
[ Section tree sidebar (240px) ] [ Section content (flex) ] [ Cross-ref panel (280px, toggleable) ]
```

URL state: `/spec?id=14` — section ID in search params so deep-links work (e.g. from Governance "accept" flow redirecting to a spec section).

---

## Components to Build

### 1. `SpecNav` — left sidebar tree
`dashboard/src/components/spec/SpecNav.tsx`

- Groups sections by domain using existing `groupByDomain()` from `lib/spec-taxonomy`
- Three collapsible groups from SPEC-INDEX: **Core** (rigid), **Operations**, **Planning**
- Fourth group: **Modules** — renders the 3 spec-modules (board-experience, channels, autonomy) with a "Draft" badge
- Each row: section ID pill (§0), heading, domain color dot, status badge if `has-proposal` or `recently-updated`
- Active section highlighted; keyboard navigation (j/k already wired in useSpecKeyboard)
- Search input at top — filters the tree in-place (no separate search page needed)

### 2. `SpecContent` — center reading pane
`dashboard/src/components/spec/SpecContent.tsx`

- Renders `section.content` as markdown via existing `markdownToHtml()`
- Breadcrumb: `SPEC > §14 > Phased Execution`
- Header row:
  - Section heading (h1 style)
  - Domain badge
  - Status badge (stable / under-review / has-proposal)
  - "Propose Change" button → opens ProposalDrawer
- In-page `§N` cross-reference links are clickable: clicking `§5` sets `?id=5` (no page reload)
- Scroll to top on section change
- Empty state on landing: renders SPEC-INDEX.md as the home view (the table already exists, just render it)

### 3. `SpecCrossRefPanel` — right sidebar
`dashboard/src/components/spec/SpecCrossRefPanel.tsx`

Reuses the existing spec-graph API (`/api/workstation/spec-graph?action=cross-refs&section=N`).

- Toggle button in content header (hide on narrow viewports)
- Two sections: **References this** (outgoing) and **Referenced by** (incoming)
- Each cross-ref is a clickable link that sets `?id=N`
- Implementation status strip: agent count, gate count, table count from `action=impact`

### 4. `ProposalDrawer` — propose a change
`dashboard/src/components/spec/ProposalDrawer.tsx`

Slide-over (same pattern as `SubmissionDetail` in governance).

- Pre-fills: section ID, section heading, current content excerpt
- Textarea: "Describe the change you want"
- Submit → POST to `/api/governance/submit` with `contentType: "spec_amendment"`, `sourceSection: sectionId`
- On success: shows confirmation + "Open in Workstation" button (deep-links to `/workstation?chip=change&prompt=...`)
- This routes through the existing governance intake pipeline (Haiku classifier → board review) — no new backend needed.

### 5. `SpecSearchBar`
Embedded in `SpecNav` header.

- Client-side: filters `SpecIndex.sections` by heading + content substring match
- Returns matching sections grouped by domain
- Keyboard: Enter selects first result, Escape clears

---

## API: Extend agenda route to expose spec modules

The agenda route already fetches `autobot-spec/spec/_index.yaml` via GitHub API. Extend it to also fetch `autobot-spec/spec-modules/*.md` and return them as `SpecSection[]` with `file` set and a synthetic domain `"modules"`.

**New route:** `GET /api/workstation/spec?source=index` — thin wrapper that calls the agenda parser's `parseSpecSections()` + `buildSpecIndexFromFiles()`, plus fetches spec-modules directory, and returns:

```ts
interface SpecPageData {
  index: SpecIndex;          // main SPEC.md sections (already parsed)
  modules: SpecSection[];    // 3 draft modules
  constitution: SpecSection[]; // CONSTITUTION.md sections (for reference)
}
```

This keeps all GitHub API access server-side.

---

## Types to Add

In `dashboard/src/components/workstation/types.ts`, add:

```ts
export type SpecSource = "main" | "module" | "constitution";

// Extend SpecSection (already has file?: string)
// Add: source?: SpecSource
```

---

## NavBar Change

Add one link to `NavBar.tsx`:

```tsx
<Link href="/spec" className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
  SPEC
</Link>
```

Place it between Workstation and Governance in the nav order.

---

## Implementation Order (minimize risk, ship value fast)

1. **NavBar link** — 5 min, zero risk
2. **`/api/workstation/spec` route** — fetches sections + modules from GitHub; reuses existing parsers
3. **`/spec` page skeleton + `SpecNav`** — section tree with search, domain groups, module drafts visible
4. **`SpecContent`** — reading pane with markdown render, breadcrumb, cross-ref link rewiring
5. **`SpecCrossRefPanel`** — reuses existing spec-graph API, mostly wiring
6. **`ProposalDrawer`** — reuses governance submit endpoint, slide-over pattern from SubmissionDetail

Total estimated scope: ~600 lines of new TSX, 1 new API route (~80 lines), 1 NavBar line. No DB migrations. No new backend endpoints — everything proxies through existing infrastructure.

---

## What NOT to Build (yet)

- **Inline editing** — spec changes go through the governance pipeline, not direct edits. The Workstation `change` chip already handles this well.
- **Full-text search backend** — client-side substring search over ~200 sections is fast enough.
- **Version history view** — CHANGELOG.md is already in the Agenda panel; don't duplicate.
- **Splitting SPEC.md into files** — the parser already handles this; the UI abstraction doesn't require it.

---

## Open Questions for Board

1. Should modules show as a separate group ("Modules — Draft") or be interleaved with the main sections by domain?
   - Recommendation: separate group with a "Draft — pending board review" banner. Keeps governance status clear.

2. Should the ProposalDrawer go directly to Governance, or pre-fill the Workstation `change` chip instead?
   - Recommendation: Governance pipeline first (Haiku classifies it). The Workstation is for implementation, not intake.

3. CONSTITUTION.md — show in the spec browser or keep it separate?
   - Recommendation: include as a read-only tab/section at the bottom of SpecNav. Board members need it as reference when reviewing proposals.
