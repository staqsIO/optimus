"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AutoBuildModal from "./AutoBuildModal";

type Engagement = {
  id: string;
  name: string;
  client: string | null;
  kind: "website" | "mobile_app" | "api" | "other";
  status: "draft" | "active" | "archived";
  is_master: boolean;
  created_at: string;
  updated_at: string;
  proposal_count: number;
  last_synth_at: string | null;
  summary: string | null;
  async_status?: "ingesting" | "synthesizing" | "generating" | null;
};

const ASYNC_LABEL: Record<string, string> = {
  ingesting: "ingesting",
  synthesizing: "synthesizing",
  generating: "generating",
};

const KIND_LABEL: Record<Engagement["kind"], string> = {
  website: "Website",
  mobile_app: "Mobile app",
  api: "API",
  other: "Other",
};

const STATUS_BADGE: Record<Engagement["status"], string> = {
  draft: "bg-zinc-800 text-zinc-400",
  active: "bg-emerald-900/50 text-emerald-300",
  archived: "bg-zinc-900 text-zinc-600",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function EngagementsListPage() {
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoBuildOpen, setAutoBuildOpen] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set());

  async function onMerge() {
    const ids = [...mergeSelection];
    if (ids.length < 2) {
      alert("Pick 2+ engagements to merge.");
      return;
    }
    const labels = engagements.filter((e) => ids.includes(e.id)).map((e) => e.name);
    const targetIdx = prompt(
      `Merge into which engagement? Type 1-${labels.length}:\n` +
        labels.map((n, i) => `${i + 1}. ${n}`).join("\n")
    );
    if (!targetIdx) return;
    const idx = parseInt(targetIdx, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= ids.length) {
      alert("Invalid choice.");
      return;
    }
    const targetId = ids[idx];
    const sourceIds = ids.filter((id) => id !== targetId);
    if (!confirm(`Merge ${sourceIds.length} engagement(s) into "${labels[idx]}"? Proposals move to target; sources are deleted.`))
      return;
    for (const sid of sourceIds) {
      const res = await fetch(`/api/engagements/${targetId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: sid }),
      });
      if (!res.ok) {
        alert(`Merge failed: ${res.status} ${await res.text()}`);
        return;
      }
    }
    setEngagements((prev) => prev.filter((e) => !sourceIds.includes(e.id)));
    setMergeSelection(new Set());
    setMergeMode(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/engagements");
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        const data = await r.json();
        if (cancelled) return;
        setEngagements(data.engagements || []);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep refreshing the list while any row has a background job in flight,
  // so badges flip from "synthesizing" → cleared without a manual reload.
  useEffect(() => {
    const anyRunning = engagements.some((e) => !!e.async_status);
    if (!anyRunning) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/engagements");
        if (!r.ok) return;
        const data = await r.json();
        setEngagements(data.engagements || []);
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [engagements]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Engagements</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Client projects we're scoping. Each one accumulates proposals and produces a living spec.
          </p>
        </div>
        <div className="flex gap-2">
          {mergeMode ? (
            <>
              <button
                onClick={onMerge}
                disabled={mergeSelection.size < 2}
                className="px-3 py-1.5 text-sm bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded transition-colors"
              >
                Merge {mergeSelection.size} selected
              </button>
              <button
                onClick={() => { setMergeMode(false); setMergeSelection(new Set()); }}
                className="px-3 py-1.5 text-sm text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setMergeMode(true)}
                className="px-3 py-1.5 text-sm text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
              >
                Merge…
              </button>
              <button
                onClick={() => setAutoBuildOpen(true)}
                className="px-3 py-1.5 text-sm text-zinc-200 bg-blue-900/40 hover:bg-blue-900/60 rounded transition-colors"
                title="Search the knowledge base for content about a client and auto-create an engagement"
              >
                Auto-build from client
              </button>
              <Link
                href="/engagements/new"
                className="px-3 py-1.5 text-sm bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors"
              >
                New engagement
              </Link>
            </>
          )}
        </div>
      </div>

      {autoBuildOpen && <AutoBuildModal onClose={() => setAutoBuildOpen(false)} />}

      {loading && <div className="text-sm text-zinc-500">Loading…</div>}
      {error && <div className="text-sm text-red-400">Error: {error}</div>}

      {!loading && !error && (
        <MasterCard
          master={engagements.find((e) => e.is_master) || null}
        />
      )}

      {!loading && !error && engagements.filter((e) => !e.is_master).length === 0 && (
        <div className="border border-dashed border-white/10 rounded-lg p-8 text-center text-zinc-500">
          <p className="mb-2">No client engagements yet.</p>
          <p className="text-sm">
            Create one, then drop in proposals (RFPs, scoping drafts, finalized scopes) to start building a living spec.
            The Master spec above will be inherited as baseline standards.
          </p>
        </div>
      )}

      {!loading && engagements.filter((e) => !e.is_master).length > 0 && (
        <div className="border border-white/10 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-zinc-500 text-xs uppercase tracking-wider">
              <tr>
                {mergeMode && <th className="px-2 py-2 w-8"></th>}
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Client</th>
                <th className="text-left px-4 py-2 font-medium">Kind</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Proposals</th>
                <th className="text-right px-4 py-2 font-medium">Last synth</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {engagements
                .filter((e) => !e.is_master)
                .map((e) => (
                  <tr key={e.id} className="group hover:bg-zinc-900/50 transition-colors">
                    {mergeMode && (
                      <td className="px-2 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={mergeSelection.has(e.id)}
                          onChange={() => {
                            setMergeSelection((prev) => {
                              const next = new Set(prev);
                              if (next.has(e.id)) next.delete(e.id);
                              else next.add(e.id);
                              return next;
                            });
                          }}
                          className="accent-amber-600"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <Link
                        href={`/engagements/${e.id}`}
                        className="text-zinc-100 hover:text-emerald-300"
                      >
                        {e.name}
                      </Link>
                      {e.summary && (
                        <div className="text-[10px] text-zinc-500 mt-1 line-clamp-2 max-w-md">
                          {e.summary}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{e.client || "—"}</td>
                    <td className="px-4 py-3 text-zinc-400">{KIND_LABEL[e.kind]}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${STATUS_BADGE[e.status]}`}
                      >
                        {e.status}
                      </span>
                      {e.async_status && (
                        <span
                          className="ml-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300"
                          title={`Background job running: ${e.async_status}`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          {ASYNC_LABEL[e.async_status] || e.async_status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400 tabular-nums">
                      {e.proposal_count}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 tabular-nums">
                      {timeAgo(e.last_synth_at)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <button
                        onClick={async () => {
                          if (!confirm(`Delete "${e.name}"? This removes the engagement, its proposals, spec, and all history. Cannot be undone.`)) return;
                          const res = await fetch(`/api/engagements/${e.id}`, { method: "DELETE" });
                          if (!res.ok) {
                            alert(`Delete failed: ${res.status} ${await res.text()}`);
                            return;
                          }
                          setEngagements((prev) => prev.filter((x) => x.id !== e.id));
                        }}
                        className="text-[10px] uppercase tracking-wider text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded transition-opacity"
                        title="Delete this engagement"
                      >
                        delete
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

function MasterCard({ master }: { master: Engagement | null }) {
  if (!master) return null;
  return (
    <Link
      href={`/engagements/${master.id}`}
      className="block mb-4 border border-amber-700/40 bg-amber-950/10 rounded-lg p-4 hover:bg-amber-950/20 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-300 bg-amber-900/40 px-1.5 py-0.5 rounded">
              ★ Master
            </span>
            <h3 className="text-sm font-semibold text-zinc-100">{master.name}</h3>
          </div>
          <p className="text-xs text-zinc-500">
            Baseline standards inherited by every client engagement on synth. Add general
            scoping principles, defaults, and lessons learned here.
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500 tabular-nums shrink-0 ml-4">
          <div>{master.proposal_count} proposals</div>
          <div>last synth {timeAgo(master.last_synth_at)}</div>
        </div>
      </div>
    </Link>
  );
}
