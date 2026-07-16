"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { opsFetch, opsPatch } from "@/lib/ops-api";
import { formatDate } from "@/lib/format";
import {
  computePrecision,
  formatConfidence,
  formatPrecision,
  type Artifact,
  type ArtifactVersion,
  type ArtifactDetailResponse,
  type ArtifactsListResponse,
  type LinkStatsCounts,
  type LinkStatsResponse,
  type PendingLink,
  type PendingLinksResponse,
  type LinkPatchResponse,
} from "@/lib/artifacts";

/* ───────── Helpers ───────── */

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  draft: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  archived: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  superseded: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_BADGE[status] ?? "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${cls}`}>
      {status}
    </span>
  );
}

const TABS = [
  { key: "browse", label: "Browse" },
  { key: "review", label: "Review Queue" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/* ───────── Detail modal ───────── */

function ArtifactDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const data = await opsFetch<ArtifactDetailResponse>(`/api/artifacts/${id}`);
      if (active && data) {
        setArtifact(data.artifact);
        setVersions(data.versions || []);
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <div className="text-sm text-zinc-500">Loading artifact…</div>
        ) : !artifact ? (
          <div className="text-sm text-zinc-500">Artifact not found.</div>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">{artifact.title}</h3>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  <span className="text-zinc-400">{artifact.kind}</span> · {artifact.source_system}
                </p>
              </div>
              <div className="ml-auto"><StatusBadge status={artifact.status} /></div>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-zinc-500">Created</dt>
                <dd className="text-zinc-300">{formatDate(artifact.created_at)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Current version</dt>
                <dd className="text-zinc-300 font-mono">{artifact.current_version_id?.slice(0, 8) ?? "--"}</dd>
              </div>
            </dl>

            <section>
              <h4 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">
                Versions ({versions.length})
              </h4>
              {versions.length === 0 ? (
                <p className="text-xs text-zinc-500">No versions recorded.</p>
              ) : (
                <div className="border border-white/5 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/5 text-zinc-500">
                        <th className="text-center px-3 py-2 font-medium">Ver</th>
                        <th className="text-left px-3 py-2 font-medium">Document</th>
                        <th className="text-left px-3 py-2 font-medium">Hash</th>
                        <th className="text-right px-3 py-2 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {versions.map((v) => (
                        <tr key={v.id} className="border-b border-white/5">
                          <td className="px-3 py-2 text-center text-zinc-400">v{v.version_no}</td>
                          <td className="px-3 py-2 text-zinc-400">{v.document_id?.slice(0, 8) ?? "--"}</td>
                          <td className="px-3 py-2 text-zinc-500">{v.content_hash?.slice(0, 12) ?? "--"}</td>
                          <td className="px-3 py-2 text-right text-zinc-500">{formatDate(v.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="flex justify-end pt-1">
              <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors">
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ───────── Browse tab ───────── */

function BrowseTab({ onSelect }: { onSelect: (id: string) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (status) qs.set("status", status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const data = await opsFetch<ArtifactsListResponse>(`/api/artifacts${suffix}`);
    setArtifacts(data?.artifacts ?? []);
    setLoading(false);
  }, [kind, status]);

  useEffect(() => { load(); }, [load]);

  // Distinct kinds/statuses for the filter dropdowns (derived from current rows).
  const kinds = Array.from(new Set(artifacts.map((a) => a.kind))).sort();
  const statuses = Array.from(new Set(artifacts.map((a) => a.status))).sort();

  // "Captured" recent = newest 8 by created_at.
  const recent = [...artifacts]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 8);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {/* Captured recent */}
      <section>
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
          Recently Captured
        </h2>
        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : recent.length === 0 ? (
          <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
            No artifacts captured yet
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {recent.map((a) => (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                className="text-left bg-zinc-900 border border-white/5 rounded-lg p-3 hover:bg-white/[0.03] transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-200 truncate flex-1">{a.title}</span>
                  <StatusBadge status={a.status} />
                </div>
                <div className="text-[11px] text-zinc-500 mt-1">
                  <span className="text-zinc-400">{a.kind}</span> · captured via {a.source_system} · {formatDate(a.created_at)}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Full table + filters */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
            All Artifacts ({artifacts.length})
          </h2>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="text-xs bg-zinc-900 border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-zinc-600"
            >
              <option value="">all kinds</option>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="text-xs bg-zinc-900 border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-zinc-600"
            >
              <option value="">all statuses</option>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={load} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              refresh
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : artifacts.length === 0 ? (
          <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
            No artifacts match these filters
          </div>
        ) : (
          <div className="border border-white/5 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/5 text-zinc-500">
                  <th className="text-left px-3 py-2 font-medium">Title</th>
                  <th className="text-left px-3 py-2 font-medium">Kind</th>
                  <th className="text-left px-3 py-2 font-medium">Source</th>
                  <th className="text-center px-3 py-2 font-medium">Status</th>
                  <th className="text-right px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => onSelect(a.id)}
                    className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2 text-zinc-200">{a.title}</td>
                    <td className="px-3 py-2 text-cyan-400 font-mono">{a.kind}</td>
                    <td className="px-3 py-2 text-zinc-400">{a.source_system}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={a.status} /></td>
                    <td className="px-3 py-2 text-right text-zinc-500">{formatDate(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ───────── SLO panel ───────── */

function PrecisionPanel({ counts, precision }: { counts: LinkStatsCounts | null; precision: number | null }) {
  if (!counts) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
      <Stat label="Auto" value={String(counts.auto)} />
      <Stat label="Pending" value={String(counts.pending)} />
      <Stat label="Confirmed" value={String(counts.confirmed)} tone="emerald" />
      <Stat label="Rejected" value={String(counts.rejected)} tone="red" />
      <Stat label="Precision" value={formatPrecision(precision)} tone="cyan" />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "red" | "cyan" }) {
  const valueCls =
    tone === "emerald" ? "text-emerald-400"
      : tone === "red" ? "text-red-400"
        : tone === "cyan" ? "text-cyan-400"
          : "text-zinc-200";
  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
      <div className="text-[11px] text-zinc-500 mb-1">{label}</div>
      <div className={`text-sm font-medium ${valueCls}`}>{value}</div>
    </div>
  );
}

/* ───────── Review tab ───────── */

function ReviewTab() {
  const [links, setLinks] = useState<PendingLink[]>([]);
  const [counts, setCounts] = useState<LinkStatsCounts | null>(null);
  const [precision, setPrecision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [pending, stats] = await Promise.all([
      opsFetch<PendingLinksResponse>("/api/artifacts/links/pending"),
      opsFetch<LinkStatsResponse>("/api/artifacts/links/stats"),
    ]);
    setLinks(pending?.links ?? []);
    if (stats) {
      setCounts(stats.counts);
      // Prefer locally-computed precision (correct even if backend omits it).
      setPrecision(computePrecision(stats.counts));
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function review(id: string, link_status: "confirmed" | "rejected") {
    setError(null);
    setBusyId(id);
    const res = await opsPatch<LinkPatchResponse>(`/api/artifacts/links/${id}`, { link_status });
    setBusyId(null);
    if (!res.ok) { setError(res.error); return; }
    await load();
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
        Auto-Link Precision
      </h2>
      <PrecisionPanel counts={counts} precision={precision} />

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
        Pending Links ({links.length})
      </h2>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading review queue…</p>
      ) : links.length === 0 ? (
        <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
          Nothing to review — all caught up.
        </div>
      ) : (
        <div className="border border-white/5 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/5 text-zinc-500">
                <th className="text-left px-3 py-2 font-medium">Artifact</th>
                <th className="text-left px-3 py-2 font-medium">Links to</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-center px-3 py-2 font-medium">Confidence</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                  <td className="px-3 py-2 text-zinc-200">
                    {link.artifact_title}
                    <span className="text-zinc-600 ml-1.5 font-mono text-[10px]">{link.kind}</span>
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{link.entity_label}</td>
                  <td className="px-3 py-2 text-cyan-400 font-mono">{link.entity_type}</td>
                  <td className="px-3 py-2 text-center text-zinc-400">{formatConfidence(link.confidence)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => review(link.id, "confirmed")}
                        disabled={busyId === link.id}
                        className="text-xs px-2 py-0.5 rounded bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30 disabled:opacity-50 transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => review(link.id, "rejected")}
                        disabled={busyId === link.id}
                        className="text-xs px-2 py-0.5 rounded bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 disabled:opacity-50 transition-colors"
                      >
                        Reject
                      </button>
                    </div>
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

function ArtifactsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get("tab") as TabKey | null;
  const artifactParam = searchParams.get("artifact");

  const [activeTab, setActiveTab] = useState<TabKey>(
    tabParam && TABS.some((t) => t.key === tabParam) ? tabParam : "browse",
  );
  const [detailId, setDetailId] = useState<string | null>(artifactParam);

  // Deep-link: ?artifact=<id> opens the detail modal (used by entity sections).
  useEffect(() => {
    setDetailId(artifactParam);
  }, [artifactParam]);

  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    router.replace(`/artifacts?tab=${tab}`, { scroll: false });
  }

  function closeDetail() {
    setDetailId(null);
    if (artifactParam) router.replace(`/artifacts?tab=${activeTab}`, { scroll: false });
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

      {activeTab === "browse" && <BrowseTab onSelect={setDetailId} />}
      {activeTab === "review" && <ReviewTab />}

      {detailId && <ArtifactDetailModal id={detailId} onClose={closeDetail} />}
    </div>
  );
}

export default function ArtifactsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-49px)] bg-zinc-950 text-sm text-zinc-500">Loading artifacts…</div>}>
      <ArtifactsPageInner />
    </Suspense>
  );
}
