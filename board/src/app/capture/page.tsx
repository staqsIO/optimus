"use client";

/**
 * Drive Folder Picker — self-serve capture-source registration (OPT-102, Feature 006).
 *
 * Browse Shared Drives + personal My-Drive folders (lazy tree), pick a folder to
 * sync, assign it an owning org + default kind + file-type allowlist, and manage
 * existing sources. owner_email is stamped server-side — never sent from here.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { opsFetch, opsPost, opsPatch } from "@/lib/ops-api";
import { formatDate } from "@/lib/format";
import {
  buildAllowlist,
  summarizeAllowlist,
  DEFAULT_KINDS,
  DEFAULT_MAX_BYTES,
  FILE_TYPE_OPTIONS,
  type CaptureSource,
  type CaptureSourcesResponse,
  type CaptureSourceResponse,
  type CreateCaptureSourceBody,
  type DefaultKind,
  type DriveAccess,
  type DriveFolder,
  type DriveFoldersResponse,
  type PatchCaptureSourceBody,
  type SharedDrive,
  type SharedDrivesResponse,
} from "@/lib/capture";

/* ───────── Owning-org dropdown source ─────────
 * The OWNING-ORG picker must list the caller's TENANCY orgs (tenancy.orgs) — the
 * only set valid for capture-source owner_org_id — NOT the signal.organizations
 * CRM (external companies the org tracks). /api/tenancy/orgs returns the former,
 * scoped to the caller's memberships, so a selection always passes the create
 * path's assertKnownOrg + assertCallerInOrg checks. */

interface OrgRow {
  id: string;
  name: string;
}

interface OrganizationsResponse {
  organizations: OrgRow[];
}

/* ───────── Tabs ───────── */

const TABS = [
  { key: "browse", label: "Browse & Sync" },
  { key: "sources", label: "Synced Sources" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/* ───────── A folder picked for the add-source modal ───────── */

interface PickedFolder {
  id: string;
  name: string;
  access: DriveAccess;
}

/* ───────── Lazy tree node ───────── */

interface TreeNodeProps {
  folder: DriveFolder;
  depth: number;
  /** drive context: shared-drive id constrains the corpus; null = personal My Drive. */
  driveId: string | null;
  access: DriveAccess;
  onSync: (picked: PickedFolder) => void;
}

function FolderNode({ folder, depth, driveId, access, onSync }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DriveFolder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children !== null) return; // already loaded
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ parent: folder.id });
    if (driveId) qs.set("driveId", driveId);
    const data = await opsFetch<DriveFoldersResponse>(`/api/drive/folders?${qs.toString()}`);
    if (!data) setError("Could not load subfolders");
    setChildren(data?.folders ?? []);
    setLoading(false);
  }, [expanded, children, folder.id, driveId]);

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 hover:bg-white/[0.03] rounded transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <button
          onClick={toggle}
          className="text-zinc-500 hover:text-zinc-300 w-4 text-center transition-colors"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="text-sm text-zinc-200 truncate flex-1">{folder.name}</span>
        <button
          onClick={() => onSync({ id: folder.id, name: folder.name, access })}
          className="text-[11px] px-2 py-0.5 rounded bg-cyan-600/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/30 transition-colors shrink-0"
        >
          Sync this folder
        </button>
      </div>
      {expanded && (
        <div>
          {loading ? (
            <div className="text-xs text-zinc-500 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}>
              Loading…
            </div>
          ) : error ? (
            <div className="text-xs text-red-400 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}>
              {error}
            </div>
          ) : children && children.length === 0 ? (
            <div className="text-xs text-zinc-600 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}>
              No subfolders
            </div>
          ) : (
            children?.map((child) => (
              <FolderNode
                key={child.id}
                folder={child}
                depth={depth + 1}
                driveId={driveId}
                access={access}
                onSync={onSync}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── A single Shared Drive (expandable) ───────── */

function DriveNode({ drive, onSync }: { drive: SharedDrive; onSync: (p: PickedFolder) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (folders !== null) return;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ parent: drive.id, driveId: drive.id });
    const data = await opsFetch<DriveFoldersResponse>(`/api/drive/folders?${qs.toString()}`);
    if (!data) setError("Could not load folders");
    setFolders(data?.folders ?? []);
    setLoading(false);
  }, [expanded, folders, drive.id]);

  return (
    <div className="border border-white/5 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 hover:bg-white/[0.03] transition-colors">
        <button onClick={toggle} className="text-zinc-500 hover:text-zinc-300 w-4 text-center transition-colors">
          {expanded ? "▾" : "▸"}
        </button>
        <span className="text-sm text-zinc-100 truncate flex-1">{drive.name}</span>
        <span
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
            drive.access === "sa_direct"
              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
              : "bg-blue-500/15 text-blue-300 border-blue-500/30"
          }`}
        >
          {drive.access}
        </span>
        <button
          onClick={() => onSync({ id: drive.id, name: drive.name, access: drive.access })}
          className="text-[11px] px-2 py-0.5 rounded bg-cyan-600/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/30 transition-colors shrink-0"
        >
          Sync drive root
        </button>
      </div>
      {expanded && (
        <div className="border-t border-white/5 py-1">
          {loading ? (
            <div className="text-xs text-zinc-500 px-3 py-1">Loading…</div>
          ) : error ? (
            <div className="text-xs text-red-400 px-3 py-1">{error}</div>
          ) : folders && folders.length === 0 ? (
            <div className="text-xs text-zinc-600 px-3 py-1">No folders</div>
          ) : (
            folders?.map((f) => (
              <FolderNode
                key={f.id}
                folder={f}
                depth={1}
                driveId={drive.id}
                access={drive.access}
                onSync={onSync}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── Add-source modal ───────── */

function AddSourceModal({
  folder,
  orgs,
  onClose,
  onCreated,
}: {
  folder: PickedFolder;
  orgs: OrgRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [kind, setKind] = useState<DefaultKind>("doc");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(["gdoc", "pdf"]),
  );
  const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function toggleType(key: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit() {
    if (!orgId) { setError("Pick an owning org"); return; }
    setSubmitting(true);
    setError(null);
    // owner_email is intentionally NOT sent — the backend stamps it from the
    // authenticated board identity (Feature 006 §1).
    const body: CreateCaptureSourceBody = {
      source_type: "drive_folder",
      external_id: folder.id,
      label: folder.name,
      owner_org_id: orgId,
      default_kind: kind,
      allowlist: buildAllowlist(selectedTypes, maxBytes),
    };
    const res = await opsPost<CaptureSourceResponse>("/api/capture-sources", body);
    setSubmitting(false);
    if (!res.ok) { setError(res.error); return; }
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-lg p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Sync folder</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5 break-all">
            <span className="text-zinc-300">{folder.name}</span> · <span className="font-mono">{folder.id}</span>
          </p>
          <p className="text-[11px] text-zinc-600 mt-1">
            {folder.access === "sa_direct"
              ? "Read directly by the service account (no impersonation)."
              : "Read by impersonating your workspace identity."}
          </p>
        </div>

        {/* Org */}
        <label className="block">
          <span className="text-[11px] text-zinc-500 uppercase tracking-widest">Owning org</span>
          <select
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            className="mt-1 w-full text-sm bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-zinc-200 focus:outline-none focus:border-zinc-600"
          >
            {orgs.length === 0 && <option value="">No orgs available</option>}
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>

        {/* Default kind */}
        <label className="block">
          <span className="text-[11px] text-zinc-500 uppercase tracking-widest">Default kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DefaultKind)}
            className="mt-1 w-full text-sm bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-zinc-200 focus:outline-none focus:border-zinc-600"
          >
            {DEFAULT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>

        {/* Allowlist file types */}
        <div>
          <span className="text-[11px] text-zinc-500 uppercase tracking-widest">File types to capture</span>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {FILE_TYPE_OPTIONS.map((opt) => (
              <label key={opt.key} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedTypes.has(opt.key)}
                  onChange={() => toggleType(opt.key)}
                  className="accent-cyan-500"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* Max bytes */}
        <label className="block">
          <span className="text-[11px] text-zinc-500 uppercase tracking-widest">Max file size (bytes)</span>
          <input
            type="number"
            min={1}
            value={maxBytes}
            onChange={(e) => setMaxBytes(Math.max(1, Number(e.target.value) || DEFAULT_MAX_BYTES))}
            className="mt-1 w-full text-sm bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-zinc-200 font-mono focus:outline-none focus:border-zinc-600"
          />
        </label>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="text-xs px-3 py-1.5 rounded bg-cyan-600/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/30 disabled:opacity-50 transition-colors"
          >
            {submitting ? "Syncing…" : "Sync folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Browse tab ───────── */

function BrowseTab({ orgs, onCreated }: { orgs: OrgRow[]; onCreated: () => void }) {
  const [drives, setDrives] = useState<SharedDrive[]>([]);
  const [personal, setPersonal] = useState<DriveFolder[] | null>(null);
  const [personalUnavailable, setPersonalUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedFolder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPersonalUnavailable(false);

    const drivesData = await opsFetch<SharedDrivesResponse>("/api/drive/shared-drives");
    if (!drivesData) {
      setError("Drive listing unavailable (not configured or not a board user).");
      setDrives([]);
      setLoading(false);
      return;
    }
    setDrives(drivesData.drives ?? []);

    // Personal My-Drive root via parent=root. A non-domain board user gets
    // 400 impersonation_unavailable → opsFetch returns null; handle gracefully.
    const personalData = await opsFetch<DriveFoldersResponse>("/api/drive/folders?parent=root");
    if (!personalData) {
      setPersonalUnavailable(true);
      setPersonal([]);
    } else {
      setPersonal(personalData.folders ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Shared Drives */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
            Shared Drives ({drives.length})
          </h2>
          <button onClick={load} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            refresh
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-zinc-500">Loading drives…</p>
        ) : drives.length === 0 ? (
          <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
            No Shared Drives available
          </div>
        ) : (
          <div className="space-y-2">
            {drives.map((d) => (
              <DriveNode key={d.id} drive={d} onSync={setPicked} />
            ))}
          </div>
        )}
      </section>

      {/* Personal My Drive */}
      <section>
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
          My Drive
        </h2>
        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : personalUnavailable ? (
          <div className="text-sm text-zinc-500 border border-white/5 rounded-lg p-6 text-center">
            Personal Drive unavailable for your account — Shared Drives only.
          </div>
        ) : personal && personal.length === 0 ? (
          <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
            No folders in My Drive root
          </div>
        ) : (
          <div className="border border-white/5 rounded-lg py-1">
            {personal?.map((f) => (
              <FolderNode
                key={f.id}
                folder={f}
                depth={0}
                driveId={null}
                access="impersonated"
                onSync={setPicked}
              />
            ))}
          </div>
        )}
      </section>

      {picked && (
        <AddSourceModal
          folder={picked}
          orgs={orgs}
          onClose={() => setPicked(null)}
          onCreated={() => { setPicked(null); onCreated(); }}
        />
      )}
    </div>
  );
}

/* ───────── Sources management tab ───────── */

function orgName(orgs: OrgRow[], id: string): string {
  return orgs.find((o) => o.id === id)?.name ?? `${id.slice(0, 8)}…`;
}

function SourcesTab({ orgs, refreshKey }: { orgs: OrgRow[]; refreshKey: number }) {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await opsFetch<CaptureSourcesResponse>("/api/capture-sources");
    setSources(data?.sources ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function toggleEnabled(source: CaptureSource) {
    setError(null);
    setBusyId(source.id);
    const body: PatchCaptureSourceBody = { enabled: !source.enabled };
    const res = await opsPatch<CaptureSourceResponse>(`/api/capture-sources/${source.id}`, body);
    setBusyId(null);
    if (!res.ok) { setError(res.error); return; }
    await load();
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
          Synced Sources ({sources.length})
        </h2>
        <button onClick={load} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading sources…</p>
      ) : sources.length === 0 ? (
        <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
          No sources synced yet — pick a folder in Browse &amp; Sync.
        </div>
      ) : (
        <div className="border border-white/5 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/5 text-zinc-500">
                <th className="text-left px-3 py-2 font-medium">Label</th>
                <th className="text-left px-3 py-2 font-medium">Folder</th>
                <th className="text-left px-3 py-2 font-medium">Org</th>
                <th className="text-left px-3 py-2 font-medium">Kind</th>
                <th className="text-left px-3 py-2 font-medium">Allowlist</th>
                <th className="text-left px-3 py-2 font-medium">Reader</th>
                <th className="text-left px-3 py-2 font-medium">Last poll</th>
                <th className="text-center px-3 py-2 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                  <td className="px-3 py-2 text-zinc-200">{s.label ?? "—"}</td>
                  <td className="px-3 py-2 text-zinc-500 font-mono">{s.external_id.slice(0, 12)}…</td>
                  <td className="px-3 py-2 text-zinc-300">{orgName(orgs, s.owner_org_id)}</td>
                  <td className="px-3 py-2 text-cyan-400 font-mono">{s.default_kind}</td>
                  <td className="px-3 py-2 text-zinc-400">{summarizeAllowlist(s.allowlist)}</td>
                  <td className="px-3 py-2 text-zinc-400">
                    {s.owner_email ? (
                      <span title="impersonated">{s.owner_email}</span>
                    ) : (
                      <span className="text-emerald-300/80" title="service account direct">sa_direct</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-500">
                    {s.last_error ? (
                      <span className="text-red-400" title={s.last_error}>error</span>
                    ) : s.last_poll_at ? (
                      formatDate(s.last_poll_at)
                    ) : (
                      "never"
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleEnabled(s)}
                      disabled={busyId === s.id}
                      className={`text-[11px] px-2 py-0.5 rounded border disabled:opacity-50 transition-colors ${
                        s.enabled
                          ? "bg-emerald-600/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-600/30"
                          : "bg-zinc-600/20 text-zinc-400 border-zinc-500/30 hover:bg-zinc-600/30"
                      }`}
                    >
                      {s.enabled ? "enabled" : "disabled"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ───────── Page ───────── */

function CapturePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get("tab") as TabKey | null;

  const [activeTab, setActiveTab] = useState<TabKey>(
    tabParam && TABS.some((t) => t.key === tabParam) ? tabParam : "browse",
  );
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      const data = await opsFetch<OrganizationsResponse>("/api/tenancy/orgs");
      if (active) setOrgs(data?.organizations ?? []);
    })();
    return () => { active = false; };
  }, []);

  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    router.replace(`/capture?tab=${tab}`, { scroll: false });
  }

  function handleCreated() {
    setRefreshKey((k) => k + 1);
    switchTab("sources");
  }

  return (
    <div className="flex flex-col h-[calc(100vh-49px)] bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-1 px-4 pt-2 border-b border-white/10 shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => switchTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors
              ${activeTab === tab.key
                ? "text-zinc-100 bg-white/[0.06] border-b-2 border-accent"
                : "text-zinc-500 hover:text-zinc-300"
              }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "browse" && <BrowseTab orgs={orgs} onCreated={handleCreated} />}
      {activeTab === "sources" && <SourcesTab orgs={orgs} refreshKey={refreshKey} />}
    </div>
  );
}

export default function CapturePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-49px)] bg-zinc-950 text-sm text-zinc-500">Loading capture…</div>}>
      <CapturePageInner />
    </Suspense>
  );
}
