"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useEventStream } from "@/hooks/useEventStream";

interface Draft {
  id: string;
  content_type: "blog" | "linkedin" | "contract";
  status: "draft" | "review" | "approved" | "published" | "rejected";
  title: string;
  slug: string;
  author: string;
  word_count: number;
  reading_time_min: number;
  cost_usd: string;
  published_url: string | null;
  campaign_id: string | null;
  source_draft_id: string | null;
  gate_results: Record<string, unknown>[] | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-500/20 text-zinc-300",
  review: "bg-yellow-500/20 text-yellow-300",
  approved: "bg-blue-500/20 text-blue-300",
  published: "bg-green-500/20 text-green-300",
  rejected: "bg-red-500/20 text-red-300",
};

const TYPE_COLORS: Record<string, string> = {
  blog: "bg-violet-500/20 text-violet-300",
  linkedin: "bg-sky-500/20 text-sky-300",
};

type FilterType = "all" | "blog" | "linkedin" | "contract";
type FilterStatus = "all" | "draft" | "review" | "approved" | "published" | "rejected";

export default function ContentPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  interface GateResult { gate_name: string; passed: boolean; details: Record<string, unknown> | null; }
  interface DraftDetail { draft: Draft & { body: string; published_url: string | null }; gates: GateResult[]; }
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [topic, setTopic] = useState("");

  // Load drafts
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterType !== "all") params.set("content_type", filterType);
    if (filterStatus !== "all") params.set("status", filterStatus);
    const data = await opsFetch<{ drafts: Draft[] }>(`/api/content/drafts?${params}`);
    setDrafts(data?.drafts || []);
    setLoading(false);
  }, [filterType, filterStatus]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  // SSE-driven refresh
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedLoad = useCallback(() => {
    if (loadTimeoutRef.current) return;
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      load();
    }, 1000);
  }, [load]);

  useEventStream("campaign_outcome_recorded", debouncedLoad);
  useEventStream("campaign_iterated", debouncedLoad);

  // Load detail when selected
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setDetailLoading(true);
    opsFetch<DraftDetail>(`/api/content/drafts/${selectedId}`).then((data) => {
      setDetail(data);
      setDetailLoading(false);
    });
  }, [selectedId]);

  // Create content request
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim()) return;
    setCreating(true);
    await opsPost("/api/content/requests", { topic: topic.trim() });
    setTopic("");
    setShowCreate(false);
    setCreating(false);
    load();
  }

  // Approve / Reject
  async function handleAction(id: string, action: "approve" | "reject") {
    await opsPost(`/api/content/drafts/${id}/${action}`);
    load();
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
    }
  }

  const statusCounts = drafts.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="flex h-full">
      {/* Left panel — list */}
      <div className="w-[360px] border-r border-zinc-800 flex flex-col shrink-0">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold text-zinc-100">Content</h1>
            <button
              onClick={() => setShowCreate(!showCreate)}
              className="px-3 py-1 text-xs font-medium rounded bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-colors"
            >
              + New
            </button>
          </div>

          {/* Create form */}
          {showCreate && (
            <form onSubmit={handleCreate} className="mb-3 space-y-2">
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What should we write about?"
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating || !topic.trim()}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
                >
                  {creating ? "Creating..." : "Generate Blog Post"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Type filter tabs */}
          <div className="flex gap-1 mb-2">
            {(["all", "blog", "linkedin", "contract"] as FilterType[]).map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
                  filterType === t
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* Status filter pills */}
          <div className="flex flex-wrap gap-1">
            {(["all", "draft", "review", "approved", "published", "rejected"] as FilterStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(filterStatus === s ? "all" : s)}
                className={`px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                  filterStatus === s
                    ? STATUS_COLORS[s] || "bg-zinc-600 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-400 border border-zinc-800"
                }`}
              >
                {s === "all" ? `All (${drafts.length})` : `${s} (${statusCounts[s] || 0})`}
              </button>
            ))}
          </div>
        </div>

        {/* Draft list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-zinc-500">Loading...</div>
          ) : drafts.length === 0 ? (
            <div className="p-4 text-sm text-zinc-500">
              No content yet. Click "+ New" to generate a blog post.
            </div>
          ) : (
            drafts.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`w-full text-left p-3 border-b border-zinc-800/50 hover:bg-white/[0.02] transition-colors ${
                  selectedId === d.id ? "bg-white/[0.06]" : ""
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${TYPE_COLORS[d.content_type]}`}>
                    {d.content_type}
                  </span>
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${STATUS_COLORS[d.status]}`}>
                    {d.status}
                  </span>
                  <span className="ml-auto text-[10px] text-zinc-600">
                    {new Date(d.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="text-sm text-zinc-200 truncate">
                  {d.title || "Untitled"}
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-zinc-500">
                  <span>{d.author}</span>
                  {d.word_count > 0 && <span>{d.word_count} words</span>}
                  {d.reading_time_min > 0 && <span>{d.reading_time_min} min</span>}
                  {d.cost_usd && <span>${parseFloat(d.cost_usd).toFixed(3)}</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel — detail */}
      <div className="flex-1 overflow-y-auto">
        {!selectedId ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500">
            <svg className="w-12 h-12 mb-4 text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <p className="text-sm">Select a draft to review</p>
            <p className="text-xs mt-1">or click "+ New" to generate content</p>
          </div>
        ) : detailLoading ? (
          <div className="p-6 text-sm text-zinc-500">Loading draft...</div>
        ) : detail ? (
          <div className="p-6">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 text-[10px] font-medium rounded ${TYPE_COLORS[detail.draft.content_type]}`}>
                    {detail.draft.content_type}
                  </span>
                  <span className={`px-2 py-0.5 text-[10px] font-medium rounded ${STATUS_COLORS[detail.draft.status]}`}>
                    {detail.draft.status}
                  </span>
                  <span className="text-xs text-zinc-500">{detail.draft.author}</span>
                  <span className="text-xs text-zinc-600">
                    {new Date(detail.draft.created_at).toLocaleString()}
                  </span>
                </div>
                <h2 className="text-xl font-semibold text-zinc-100">
                  {detail.draft.title || "Untitled"}
                </h2>
                <div className="flex gap-4 mt-1 text-xs text-zinc-500">
                  {detail.draft.word_count > 0 && <span>{detail.draft.word_count} words</span>}
                  {detail.draft.reading_time_min > 0 && <span>{detail.draft.reading_time_min} min read</span>}
                  <span>${parseFloat(detail.draft.cost_usd || "0").toFixed(4)}</span>
                </div>
              </div>

              {/* Actions */}
              {detail.draft.status === "review" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction(detail.draft.id, "approve")}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleAction(detail.draft.id, "reject")}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>

            {/* PR link */}
            {detail.draft.published_url && (
              <a
                href={detail.draft.published_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 mb-4 text-xs font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                View PR
              </a>
            )}

            {/* Gate results */}
            {detail.gates.length > 0 && (
              <details className="mb-4">
                <summary className="text-xs font-medium text-zinc-400 cursor-pointer hover:text-zinc-300">
                  Content Gates ({detail.gates.filter((g) => g.passed).length}/{detail.gates.length} passed)
                </summary>
                <div className="mt-2 space-y-1">
                  {detail.gates.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className={g.passed ? "text-emerald-400" : "text-red-400"}>
                        {g.passed ? "PASS" : "FAIL"}
                      </span>
                      <span className="text-zinc-400">{g.gate_name.replace(/_/g, " ")}</span>
                      {!g.passed && g.details && (
                        <span className="text-red-400/60 text-[10px]">
                          {JSON.stringify(g.details).slice(0, 80)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Divider */}
            <div className="h-px bg-zinc-800 mb-4" />

            {/* Body */}
            <div className="prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {detail.draft.body || "No content available."}
            </div>
          </div>
        ) : (
          <div className="p-6 text-sm text-zinc-500">Draft not found.</div>
        )}
      </div>
    </div>
  );
}
