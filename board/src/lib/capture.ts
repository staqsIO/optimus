/**
 * Drive capture-source surfaces (OPT-102, Feature 006).
 *
 * Shared TypeScript shapes + pure helpers for the Drive picker board page,
 * consumed through the board `/api/ops` proxy via `opsFetch`/`opsPost`/`opsPatch`.
 *
 * Backend routes (OPT-101, live in prod):
 *   GET   /api/drive/shared-drives          → { ok, drives, nextPageToken }
 *   GET   /api/drive/folders?parent=<id>    → { ok, folders, nextPageToken }
 *   GET   /api/capture-sources              → { ok, sources }
 *   POST  /api/capture-sources              → 201/200  (owner_email server-stamped)
 *   PATCH /api/capture-sources/:id          → { ok, source }
 *
 * Security note: owner_email is stamped server-side from the authenticated
 * board identity — the UI NEVER sends it. (Feature 006 §1, §2.)
 */

/* ───────── Drive listing ───────── */

/** Whether a Shared Drive is reached by impersonating the board user (DWD) or
 *  the service account directly (SA is a member of the drive). */
export type DriveAccess = "impersonated" | "sa_direct";

export interface SharedDrive {
  id: string;
  name: string;
  access: DriveAccess;
}

export interface SharedDrivesResponse {
  ok: boolean;
  drives: SharedDrive[];
  nextPageToken?: string | null;
}

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveFoldersResponse {
  ok: boolean;
  folders: DriveFolder[];
  nextPageToken?: string | null;
}

/** Backend error envelope ({ error: '...' }) the picker surfaces inline. */
export interface OpsErrorBody {
  error: string;
  detail?: string;
}

/* ───────── Capture sources ───────── */

/** A folder/MIME allowlist, the shape the watcher consumes for filtering. */
export interface CaptureAllowlist {
  mime: string[];
  ext: string[];
  max_bytes: number;
}

export type DefaultKind =
  | "proposal"
  | "prd"
  | "spec"
  | "adr"
  | "brief"
  | "deck"
  | "transcript"
  | "summary"
  | "doc"
  | "other";

export const DEFAULT_KINDS: readonly DefaultKind[] = [
  "proposal",
  "prd",
  "spec",
  "adr",
  "brief",
  "deck",
  "transcript",
  "summary",
  "doc",
  "other",
] as const;

export interface CaptureSource {
  id: string;
  source_type: string;
  external_id: string;
  label: string | null;
  owner_org_id: string;
  owner_id: string | null;
  default_kind: string;
  allowlist: CaptureAllowlist | null;
  enabled: boolean;
  owner_email: string | null;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface CaptureSourcesResponse {
  ok: boolean;
  sources: CaptureSource[];
}

export interface CaptureSourceResponse {
  ok: boolean;
  source: CaptureSource;
}

/** Body sent to POST /api/capture-sources. owner_email is deliberately absent —
 *  the backend stamps it from the authenticated identity (Feature 006 §1). */
export interface CreateCaptureSourceBody {
  source_type: "drive_folder";
  external_id: string;
  label?: string;
  owner_org_id: string;
  default_kind: DefaultKind;
  allowlist: CaptureAllowlist;
}

/** Body sent to PATCH /api/capture-sources/:id (all fields optional). */
export interface PatchCaptureSourceBody {
  enabled?: boolean;
  default_kind?: DefaultKind;
  allowlist?: CaptureAllowlist;
  label?: string;
  owner_org_id?: string;
}

/* ───────── File-type allowlist presets ───────── */

/** A user-facing file-type toggle that maps to mime/ext fragments. */
export interface FileTypeOption {
  key: string;
  label: string;
  mime: string[];
  ext: string[];
}

export const FILE_TYPE_OPTIONS: readonly FileTypeOption[] = [
  { key: "gdoc", label: "Google Docs", mime: ["application/vnd.google-apps.document"], ext: [] },
  { key: "pdf", label: "PDF", mime: ["application/pdf"], ext: ["pdf"] },
  { key: "md", label: "Markdown", mime: [], ext: ["md"] },
  { key: "docx", label: "Word (.docx)", mime: [], ext: ["docx"] },
  { key: "txt", label: "Plain text", mime: [], ext: ["txt"] },
] as const;

export const DEFAULT_MAX_BYTES = 1_048_576;

/**
 * Build a `{ mime, ext, max_bytes }` allowlist from the set of selected
 * file-type option keys. Deduplicates fragments and preserves option order.
 */
export function buildAllowlist(
  selectedKeys: Iterable<string>,
  maxBytes: number = DEFAULT_MAX_BYTES,
): CaptureAllowlist {
  const selected = new Set(selectedKeys);
  const mime: string[] = [];
  const ext: string[] = [];
  for (const opt of FILE_TYPE_OPTIONS) {
    if (!selected.has(opt.key)) continue;
    for (const m of opt.mime) if (!mime.includes(m)) mime.push(m);
    for (const e of opt.ext) if (!ext.includes(e)) ext.push(e);
  }
  return { mime, ext, max_bytes: maxBytes };
}

/** Human-readable one-line summary of an allowlist for the management table. */
export function summarizeAllowlist(allowlist: CaptureAllowlist | null): string {
  if (!allowlist) return "—";
  const parts: string[] = [];
  const keys = FILE_TYPE_OPTIONS.filter((opt) => {
    const mimeMatch = opt.mime.some((m) => allowlist.mime?.includes(m));
    const extMatch = opt.ext.some((e) => allowlist.ext?.includes(e));
    return mimeMatch || extMatch;
  }).map((opt) => opt.label);
  if (keys.length) parts.push(keys.join(", "));
  const raw =
    (allowlist.mime?.length ?? 0) + (allowlist.ext?.length ?? 0);
  if (!keys.length && raw > 0) parts.push(`${raw} type(s)`);
  if (!parts.length) parts.push("any");
  return parts.join(" · ");
}
