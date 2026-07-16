"use client";

import { useCallback, useEffect, useState } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useEventStream, type EventStreamEvent } from "@/hooks/useEventStream";

interface Cluster {
  signature: string;
  agent_id: string;
  sample_work_item_id: string | null;
  payload: Record<string, unknown>;
  count: number;
  first_seen: string;
  last_seen: string;
  ids: number[];
}

interface CatchupResponse {
  since: string;
  total: number;
  clusters: Cluster[];
}

interface NeedsAttentionEvent extends EventStreamEvent {
  reason_signature?: string;
  agent_id?: string;
  work_item_id?: string;
  to_state?: string;
  retry_count?: number;
  created_at?: string;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export default function NeedsAttentionBanner() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [acking, setAcking] = useState<string | null>(null);

  // Catch-up on mount: fetch unacked clusters from the last 30 min so we
  // surface incidents that fired while no SSE client was connected.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await opsFetch<CatchupResponse>("/api/needs-attention");
      if (!cancelled && data) setClusters(data.clusters);
    })();
    return () => { cancelled = true; };
  }, []);

  // Live updates via SSE — merge by signature, increment count if dupe.
  const onLiveEvent = useCallback((evt: EventStreamEvent) => {
    const e = evt as NeedsAttentionEvent;
    const signature = e.reason_signature;
    if (!signature) return;
    setClusters((prev) => {
      const idx = prev.findIndex((c) => c.signature === signature);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          count: next[idx].count + 1,
          last_seen: e.created_at || new Date().toISOString(),
        };
        return next;
      }
      return [
        {
          signature,
          agent_id: e.agent_id || "unknown",
          sample_work_item_id: e.work_item_id || null,
          payload: e as Record<string, unknown>,
          count: 1,
          first_seen: e.created_at || new Date().toISOString(),
          last_seen: e.created_at || new Date().toISOString(),
          ids: [],
        },
        ...prev,
      ];
    });
  }, []);
  useEventStream("needs_attention", onLiveEvent);

  const ackCluster = useCallback(async (signature: string) => {
    setAcking(signature);
    const result = await opsPost<{ ok: true; signature: string }>(
      "/api/needs-attention/ack-cluster",
      { signature }
    );
    if (result.ok) {
      setClusters((prev) => prev.filter((c) => c.signature !== signature));
    }
    setAcking(null);
  }, []);

  if (clusters.length === 0) return null;

  const total = clusters.reduce((sum, c) => sum + c.count, 0);
  const mostRecent = clusters[0];

  return (
    <div className="mb-4 rounded-md border border-red-700 bg-red-950/40 text-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-red-200 hover:bg-red-950/60"
      >
        <span className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
          <strong>{total}</strong> retry-exhausted failure{total !== 1 ? "s" : ""}
          {clusters.length > 1 ? ` across ${clusters.length} signatures` : ""}
          <span className="text-red-400/70">
            · latest: {mostRecent.agent_id} · {formatRelative(mostRecent.last_seen)}
          </span>
        </span>
        <span className="text-red-400/70">{expanded ? "▾ collapse" : "▸ expand"}</span>
      </button>
      {expanded && (
        <ul className="divide-y divide-red-900/50 border-t border-red-900/50">
          {clusters.map((c) => (
            <li key={c.signature} className="flex items-center justify-between gap-4 px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-red-300">
                  {c.signature} · {c.agent_id} · ×{c.count}
                </div>
                <div className="truncate text-xs text-red-400/70">
                  {c.sample_work_item_id ? (
                    <a
                      className="underline hover:text-red-200"
                      href={`/activity?work_item_id=${c.sample_work_item_id}`}
                    >
                      sample: {c.sample_work_item_id}
                    </a>
                  ) : null}
                  {" "}· first {formatRelative(c.first_seen)} · last {formatRelative(c.last_seen)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => ackCluster(c.signature)}
                disabled={acking === c.signature}
                className="shrink-0 rounded border border-red-700 px-2 py-1 text-xs text-red-200 hover:bg-red-900 disabled:opacity-50"
              >
                {acking === c.signature ? "acking…" : "acknowledge"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
