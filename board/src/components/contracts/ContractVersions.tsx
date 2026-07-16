"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import ContractVersionDiff from "./ContractVersionDiff";

interface Version {
  id: string;
  version_number: number;
  word_count: number;
  change_source: "initial" | "manual" | "ai_edit" | "revert" | "counter_proposal";
  change_summary: string | null;
  created_by: string;
  cost_usd: string | number | null;
  model: string | null;
  parent_version_id: string | null;
  created_at: string;
  source_count?: number;
}

interface RagChunk {
  ref: number;
  text: string;
  source: string;
  documentId: string | null;
  title: string | null;
  similarity: number | null;
  happenedAt: string | null;
  participants: unknown;
}

interface VersionDetail {
  id: string;
  version_number: number;
  rag_chunks: RagChunk[] | null;
}

interface ContractVersionsProps {
  contractId: string;
  open: boolean;
  onClose: () => void;
  onReverted: (newBody: string) => void;
  /** Incremented whenever the caller knows a new version may exist — triggers a refetch. */
  refreshKey?: number;
}

const SOURCE_BADGE: Record<Version["change_source"], { label: string; className: string }> = {
  initial:           { label: "initial",     className: "bg-zinc-600/30 text-zinc-400" },
  manual:            { label: "manual edit", className: "bg-sky-500/20 text-sky-300" },
  ai_edit:           { label: "AI edit",     className: "bg-violet-500/20 text-violet-300" },
  revert:            { label: "revert",      className: "bg-amber-500/20 text-amber-300" },
  counter_proposal:  { label: "counter",     className: "bg-emerald-500/20 text-emerald-300" },
};

function formatCost(cost: Version["cost_usd"]): string | null {
  if (cost === null || cost === undefined) return null;
  const n = typeof cost === "string" ? parseFloat(cost) : cost;
  if (Number.isNaN(n) || n === 0) return null;
  return `$${n.toFixed(4)}`;
}

export default function ContractVersions({ contractId, open, onClose, onReverted, refreshKey = 0 }: ContractVersionsProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourcesFor, setSourcesFor] = useState<{ versionNumber: number; chunks: RagChunk[] } | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  // Comparison state: when set, opens the side-by-side diff modal between
  // these two version refs. "current" resolves server-side to the live draft.
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  // Multi-select mode lets the user pick exactly two versions and hit
  // "Compare selected". Single-version compare just goes against current.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  async function openSources(v: Version) {
    setLoadingSources(true);
    const data = await opsFetch<{ version: VersionDetail }>(`/api/contracts/${contractId}/versions/${v.id}`);
    setLoadingSources(false);
    if (data?.version) {
      setSourcesFor({
        versionNumber: v.version_number,
        chunks: data.version.rag_chunks || [],
      });
    }
  }

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    try {
      const data = await opsFetch<{ versions: Version[] }>(`/api/contracts/${contractId}/versions`);
      setVersions(data?.versions || []);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    if (open) load();
  }, [open, load, refreshKey]);

  async function handleRevert(v: Version) {
    if (!window.confirm(`Revert to v${v.version_number}? Your current body will be saved as a new version first, so this is undoable.`)) return;
    setReverting(v.id);
    setError(null);
    try {
      const result = await opsPost<{ body: string }>(`/api/contracts/${contractId}/revert/${v.id}`);
      if (result.ok) {
        if (result.data?.body) {
          onReverted(result.data.body);
          await load();
        } else {
          setError("Revert returned no body");
        }
      } else {
        setError(result.error || "Revert failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReverting(null);
    }
  }

  if (!open) return null;

  return (
    <div className="absolute right-0 top-full mt-1 w-[380px] max-h-[500px] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl z-50">
      <div className="sticky top-0 bg-zinc-950 border-b border-zinc-800 px-3 py-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-zinc-200">Version History</h3>
        <div className="flex items-center gap-1">
          {versions.length >= 2 && (
            <button
              onClick={() => {
                setPicking((p) => {
                  if (p) setPicked([]);
                  return !p;
                });
              }}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                picking
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700"
              }`}
              title="Pick two versions to compare side-by-side"
            >
              {picking ? `pick ${picked.length}/2` : "compare…"}
            </button>
          )}
          {picking && picked.length === 2 && (
            <button
              onClick={() => {
                // Order so `a` is the older version, `b` is the newer one,
                // regardless of click order. Avoids a confusing "deletes look
                // like adds" first impression.
                const ordered = [...picked].sort((x, y) => {
                  const vx = versions.find((v) => v.id === x)?.version_number ?? 0;
                  const vy = versions.find((v) => v.id === y)?.version_number ?? 0;
                  return vx - vy;
                });
                setCompare({ a: ordered[0], b: ordered[1] });
                setPicking(false);
                setPicked([]);
              }}
              className="px-1.5 py-0.5 text-[10px] rounded bg-amber-600 text-white hover:bg-amber-500"
            >
              go
            </button>
          )}
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm leading-none px-1">×</button>
        </div>
      </div>

      {loading && versions.length === 0 && (
        <div className="p-4 text-xs text-zinc-500 text-center">Loading...</div>
      )}

      {!loading && versions.length === 0 && (
        <div className="p-4 text-xs text-zinc-500 text-center">No version history yet</div>
      )}

      {error && (
        <div className="mx-3 my-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-[10px] text-red-300">
          {error}
        </div>
      )}

      <ul className="divide-y divide-zinc-800/50">
        {versions.map((v, idx) => {
          const badge = SOURCE_BADGE[v.change_source] || SOURCE_BADGE.manual;
          const isCurrent = idx === 0;
          const cost = formatCost(v.cost_usd);
          const isPicked = picked.includes(v.id);
          const togglePick = () => {
            setPicked((cur) => {
              if (cur.includes(v.id)) return cur.filter((x) => x !== v.id);
              if (cur.length >= 2) return [cur[1], v.id]; // sliding window of 2
              return [...cur, v.id];
            });
          };
          return (
            <li
              key={v.id}
              className={`px-3 py-2.5 hover:bg-white/[0.02] ${picking ? "cursor-pointer" : ""} ${isPicked ? "bg-amber-500/[0.06]" : ""}`}
              onClick={picking ? togglePick : undefined}
            >
              <div className="flex items-start gap-2">
                {picking && (
                  <input
                    type="checkbox"
                    checked={isPicked}
                    readOnly
                    className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50 pointer-events-none"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[11px] font-mono text-zinc-400">v{v.version_number}</span>
                    <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${badge.className}`}>
                      {badge.label}
                    </span>
                    {isCurrent && (
                      <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        current
                      </span>
                    )}
                  </div>
                  {v.change_summary && (
                    <p className="text-[11px] text-zinc-300 leading-snug break-words">{v.change_summary}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-zinc-500">
                    <span>{new Date(v.created_at).toLocaleString()}</span>
                    <span>·</span>
                    <span>{v.created_by}</span>
                    <span>·</span>
                    <span>{v.word_count} words</span>
                    {cost && (<><span>·</span><span>{cost}</span></>)}
                    {v.model && (<><span>·</span><span className="font-mono">{v.model.split("-").slice(0, 2).join("-")}</span></>)}
                    {v.change_source === "ai_edit" && (v.source_count ?? 0) > 0 && (
                      <>
                        <span>·</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); openSources(v); }}
                          className="text-violet-400 hover:text-violet-300 hover:underline underline-offset-2"
                          title="Which RAG chunks fed this AI edit"
                        >
                          {v.source_count} source{v.source_count === 1 ? "" : "s"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {!picking && (
                  <div className="shrink-0 flex flex-col gap-1">
                    {!isCurrent && (
                      <button
                        onClick={() => setCompare({ a: v.id, b: "current" })}
                        className="px-2 py-1 text-[10px] font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-sky-600 hover:text-white transition-colors"
                        title={`Diff v${v.version_number} vs the current draft`}
                      >
                        Compare
                      </button>
                    )}
                    {!isCurrent && (
                      <button
                        onClick={() => handleRevert(v)}
                        disabled={reverting === v.id}
                        className="px-2 py-1 text-[10px] font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-amber-600 hover:text-white disabled:opacity-50 transition-colors"
                      >
                        {reverting === v.id ? "..." : "Revert"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {compare && (
        <ContractVersionDiff
          contractId={contractId}
          versions={versions.map((v) => ({
            id: v.id,
            version_number: v.version_number,
            change_source: v.change_source,
            created_at: v.created_at,
          }))}
          initialA={compare.a}
          initialB={compare.b}
          onClose={() => setCompare(null)}
        />
      )}

      {(sourcesFor || loadingSources) && (
        <div
          onClick={() => setSourcesFor(null)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Sources for v{sourcesFor?.versionNumber ?? ""}
                </h3>
                <p className="text-[10px] text-zinc-500">
                  Retrieved-context chunks the AI saw when it wrote this version
                </p>
              </div>
              <button
                onClick={() => setSourcesFor(null)}
                className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {loadingSources && <div className="p-4 text-xs text-zinc-500">Loading...</div>}
              {sourcesFor && sourcesFor.chunks.length === 0 && !loadingSources && (
                <div className="p-4 text-xs text-zinc-500">No sources recorded for this version.</div>
              )}
              {sourcesFor && sourcesFor.chunks.length > 0 && (
                <ul className="divide-y divide-zinc-800/50">
                  {sourcesFor.chunks.map((c) => (
                    <li key={c.ref} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="px-1.5 py-0.5 text-[9px] font-mono rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
                          ref {c.ref}
                        </span>
                        <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-zinc-800 text-zinc-300">
                          {c.source}
                        </span>
                        {c.similarity !== null && (
                          <span className="text-[9px] text-zinc-500">sim {c.similarity.toFixed(3)}</span>
                        )}
                        {c.happenedAt && (
                          <span className="text-[9px] text-zinc-500">{new Date(c.happenedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                      {c.title && (
                        <div className="text-[11px] text-zinc-300 font-medium mb-1 truncate">{c.title}</div>
                      )}
                      <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[200px] overflow-y-auto">
                        {c.text}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
