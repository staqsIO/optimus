/**
 * Artifact / enrichment surfaces (OPT-94 PR B).
 *
 * Shared TypeScript shapes for the backend artifact endpoints (OPT-92/93/94 PR A),
 * consumed through the board `/api/ops` proxy via `opsFetch`/`opsPatch`.
 *
 * Backend routes:
 *   GET   /api/artifacts                       → { ok, artifacts }
 *   GET   /api/artifacts/:id                   → { ok, artifact, versions }
 *   GET   /api/artifacts/enrich/contact/:id    → { ok, entity_type, entity_id, links, facts }
 *   GET   /api/artifacts/enrich/project/:id    → { ok, ... } (no engagement/org route)
 *   GET   /api/artifacts/links/pending         → { ok, links }
 *   PATCH /api/artifacts/links/:id             → { ok, link }   (board-human-only)
 *   GET   /api/artifacts/links/stats           → { ok, counts, reviewed, precision }
 */

export type LinkStatus = "auto" | "pending" | "confirmed" | "rejected";

export interface Artifact {
  id: string;
  kind: string;
  title: string;
  status: string;
  source_system: string;
  current_version_id: string | null;
  owner_org_id: string | null;
  created_at: string;
}

export interface ArtifactVersion {
  id: string;
  version_no: number;
  document_id: string | null;
  content_hash: string | null;
  created_at: string;
}

export interface ArtifactLink {
  id: string;
  artifact_id: string;
  entity_type: string;
  entity_id: string;
  confidence: number | null;
  link_status: LinkStatus;
  created_at?: string;
}

export interface ArtifactFact {
  id: string;
  fact: string;
  artifact_id: string;
  document_id: string | null;
  confidence: number | null;
  created_at: string;
}

export interface PendingLink {
  id: string;
  artifact_id: string;
  artifact_title: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  confidence: number | null;
  created_at: string;
}

export interface LinkStatsCounts {
  auto: number;
  pending: number;
  confirmed: number;
  rejected: number;
}

/* ───────── API response envelopes ───────── */

export interface ArtifactsListResponse {
  ok: boolean;
  artifacts: Artifact[];
}

export interface ArtifactDetailResponse {
  ok: boolean;
  artifact: Artifact;
  versions: ArtifactVersion[];
}

export interface EnrichResponse {
  ok: boolean;
  entity_type: string;
  entity_id: string;
  links: ArtifactLink[];
  facts: ArtifactFact[];
}

export interface PendingLinksResponse {
  ok: boolean;
  links: PendingLink[];
}

export interface LinkStatsResponse {
  ok: boolean;
  counts: LinkStatsCounts;
  reviewed: number;
  /** confirmed / (confirmed + rejected); null when no reviews yet. */
  precision: number | null;
}

export interface LinkPatchResponse {
  ok: boolean;
  link: ArtifactLink;
}

/* ───────── Pure helpers ───────── */

/**
 * Auto-link precision = confirmed / (confirmed + rejected).
 * Returns null when there are no reviews yet (avoids 0/0 → NaN).
 *
 * The backend already returns `precision`, but the board recomputes it from
 * counts so the SLO panel stays correct even if the backend field is absent.
 */
export function computePrecision(counts: LinkStatsCounts): number | null {
  const reviewed = counts.confirmed + counts.rejected;
  if (reviewed <= 0) return null;
  return counts.confirmed / reviewed;
}

/** Format a 0–1 ratio as a whole-number percentage string, or a placeholder. */
export function formatPrecision(precision: number | null): string {
  if (precision == null) return "no reviews yet";
  return `${Math.round(precision * 100)}%`;
}

/** Format a 0–1 confidence as a percentage, tolerating null. */
export function formatConfidence(confidence: number | null | undefined): string {
  if (confidence == null) return "--";
  return `${Math.round(confidence * 100)}%`;
}
