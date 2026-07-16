"use client";

// ADR-017 — sharing metrics panel for /governance.
// Reads /api/sharing/metrics and renders summary cards + a tiny sparkline of
// lifecycle activity, plus the top-N most-used grants (per-retrieval audit).

import { useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface MetricsResponse {
  lifecycle: Array<{ day: string; status: string; n: number }>;
  usage: Array<{ day: string; retrievals: number; callers: number; docs: number }>;
  top_grants: Array<{
    id: string;
    granter_type: string;
    granter_id: string;
    target_type: string;
    target_id: string;
    scope_type: string;
    status: string;
    retrievals: number;
  }>;
  summary: {
    active_total?: number;
    pending_total?: number;
    org_to_org?: number;
    avg_accept_seconds?: number | null;
  };
  window_days?: number;
}

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export default function SharingMetrics() {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await opsFetch<MetricsResponse>("/api/sharing/metrics?days=30");
      if (!cancelled) {
        setData(r);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
        <h2 className="text-sm font-medium text-zinc-200 mb-2">Knowledge sharing (30d)</h2>
        <div className="text-xs text-zinc-500">Loading…</div>
      </section>
    );
  }
  if (!data) {
    return null;
  }

  const totalRetrievals = data.usage.reduce((sum, d) => sum + d.retrievals, 0);
  const maxRetrievals = Math.max(1, ...data.usage.map((d) => d.retrievals));

  return (
    <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-zinc-200">Knowledge sharing (30d)</h2>
        <Link href="/sharing" className="text-[11px] text-violet-300 hover:text-violet-200">
          /sharing →
        </Link>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Card label="Active grants" value={String(data.summary.active_total ?? 0)} />
        <Card label="Pending" value={String(data.summary.pending_total ?? 0)} tint="amber" />
        <Card label="Org ↔ Org" value={String(data.summary.org_to_org ?? 0)} tint="violet" />
        <Card label="Avg accept" value={fmtDuration(data.summary.avg_accept_seconds)} />
      </div>

      {/* Usage sparkline */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Shared-doc retrievals</span>
          <span className="text-[10px] text-zinc-500">{totalRetrievals.toLocaleString()} total</span>
        </div>
        {data.usage.length === 0 ? (
          <div className="text-[11px] text-zinc-600 italic">No shared-doc retrievals yet in this window.</div>
        ) : (
          <div className="flex items-end gap-0.5 h-12">
            {data.usage.slice().reverse().map((d) => (
              <div
                key={d.day}
                className="flex-1 bg-violet-500/30 hover:bg-violet-500/60 rounded-sm transition-colors"
                style={{ height: `${(d.retrievals / maxRetrievals) * 100}%` }}
                title={`${d.day.slice(0, 10)}: ${d.retrievals} retrievals · ${d.callers} callers · ${d.docs} docs`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Top grants */}
      {data.top_grants.length > 0 && (
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Top grants by usage</h3>
          <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden">
            {data.top_grants.map((g) => (
              <li key={g.id} className="px-3 py-2 flex items-center justify-between text-xs">
                <div className="flex-1 min-w-0 truncate text-zinc-300">
                  <span className="text-[10px] text-violet-400 mr-1">{g.granter_type}</span>
                  <span className="font-mono">{g.granter_id.slice(0, 8)}</span>
                  <span className="text-zinc-500 mx-1">→</span>
                  <span className="text-[10px] text-cyan-400 mr-1">{g.target_type}</span>
                  <span className="font-mono">{g.target_id.slice(0, 8)}</span>
                  <span className="text-[10px] text-zinc-500 ml-2">{g.scope_type}</span>
                </div>
                <span className="text-zinc-100 font-mono">{g.retrievals}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Card({ label, value, tint }: { label: string; value: string; tint?: "amber" | "violet" }) {
  const tintClass =
    tint === "amber"  ? "text-amber-300"
    : tint === "violet" ? "text-violet-300"
    :                    "text-zinc-100";
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">{label}</div>
      <div className={`text-lg font-light ${tintClass}`}>{value}</div>
    </div>
  );
}
