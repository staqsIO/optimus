"use client";

import { useState, useEffect, useCallback } from "react";
import { type Draft } from "./QueueItem";

type SearchChunk = {
  text: string;
  similarity?: number;
  documentId?: string;
  metadata?: { title?: string; speakers?: string[]; source?: string };
};

export default function GroundedInPanel({
  draft,
  /** When set, no search API calls — illustrative chunks only (stakeholder demo). */
  demoChunks,
}: {
  draft: Draft;
  demoChunks?: SearchChunk[];
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [chunks, setChunks] = useState<SearchChunk[] | null>(demoChunks ?? null);
  const [error, setError] = useState<string | null>(null);

  const email = draft.emails;
  const queryText = `${email.subject || ""} ${email.from_name || ""} ${email.from_address || ""}`.trim();

  const load = useCallback(async () => {
    if (demoChunks) return;
    if (chunks !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/search",
          body: {
            query: queryText.slice(0, 500) || "email context",
            matchCount: 5,
            raw: true,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Search failed (${res.status})`);
        setChunks([]);
        return;
      }
      const list = (data.chunks as SearchChunk[]) || [];
      setChunks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
      setChunks([]);
    } finally {
      setLoading(false);
    }
  }, [chunks, loading, queryText, demoChunks]);

  useEffect(() => {
    if (demoChunks) return;
    if (open && chunks === null && !loading) {
      void load();
    }
  }, [open, chunks, loading, load, demoChunks]);

  useEffect(() => {
    if (demoChunks) {
      setChunks(demoChunks);
      setError(null);
      setOpen(false);
      return;
    }
    setChunks(null);
    setError(null);
    setOpen(false);
  }, [draft.id, demoChunks]);

  return (
    <div className="border-b border-white/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-xs font-medium text-zinc-300">Grounded in knowledge base</span>
        <span className="text-[10px] text-zinc-500">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          <p className="text-[11px] text-zinc-500 mb-2">
            {demoChunks
              ? "Illustrative sources only — not loaded from your knowledge base."
              : "Top matching chunks from your KB for this thread (vector search). Not identical to what the responder saw at draft time, but useful context."}
          </p>
          {loading && <p className="text-xs text-zinc-500">Loading sources…</p>}
          {error && <p className="text-xs text-red-400/90">{error}</p>}
          {!loading && chunks && chunks.length === 0 && !error && (
            <p className="text-xs text-zinc-500">No close matches in the index right now.</p>
          )}
          {!loading && chunks && chunks.length > 0 && (
            <ul className="space-y-2 max-h-48 overflow-y-auto">
              {chunks.map((c, i) => {
                const title =
                  c.metadata?.title ||
                  (c.metadata?.speakers?.length ? c.metadata.speakers.join(", ") : null) ||
                  c.documentId?.slice(0, 8) ||
                  `Source ${i + 1}`;
                const preview = (c.text || "").slice(0, 220).trim();
                return (
                  <li
                    key={`${c.documentId}-${i}`}
                    className="text-xs rounded-md border border-white/5 bg-black/20 px-2 py-1.5"
                  >
                    <div className="text-zinc-300 font-medium truncate">{title}</div>
                    {preview && <div className="text-zinc-500 mt-0.5 line-clamp-3">{preview}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
