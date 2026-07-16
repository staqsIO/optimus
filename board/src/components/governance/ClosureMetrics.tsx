"use client";

import { useState, useEffect } from "react";

interface ClosureMetricsData {
  autonomous_closure_rate: number | null;
  cost_per_closed_loop: number | null;
  closed_loops: number;
  autonomous_loops: number;
  total_loop_cost_usd: number;
  window: string;
  computed_at: string | null;
}

// OPT-52: the headline governance number. Fraction of closed loops (work_items
// reaching `completed`) that closed with zero human-task touch, plus the average
// $ cost to close a loop. Sourced from the agent_graph.autonomous_closure_metrics
// materialized view via GET /api/governance/closure-metrics.
export default function ClosureMetrics() {
  const [data, setData] = useState<ClosureMetricsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        const res = await fetch(
          "/api/governance?path=/api/governance/closure-metrics",
        );
        if (res.ok && !cancelled) {
          setData(await res.json());
        }
      } catch {
        /* leave last-good data in place */
      }
      if (!cancelled) setLoading(false);
    }
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="text-center py-4 text-zinc-500 text-sm">
        Loading closure metrics...
      </div>
    );
  }
  if (!data) return null;

  const ratePct =
    data.autonomous_closure_rate === null
      ? "—"
      : `${(data.autonomous_closure_rate * 100).toFixed(1)}%`;
  const cost =
    data.cost_per_closed_loop === null
      ? "—"
      : `$${data.cost_per_closed_loop.toFixed(4)}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">
          Autonomous Closure
        </h2>
        {data.computed_at && (
          <span className="text-[10px] text-zinc-600">
            {new Date(data.computed_at).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="Autonomous Closure Rate"
          value={ratePct}
          sub={`${data.autonomous_loops}/${data.closed_loops} loops, zero human touch`}
          color="text-emerald-400"
        />
        <MetricCard
          label="Cost / Closed Loop"
          value={cost}
          sub={`$${data.total_loop_cost_usd.toFixed(2)} over ${data.closed_loops} loops`}
        />
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="px-3 py-2.5 bg-zinc-800/30 rounded-lg border border-white/5">
      <span className="text-[10px] text-zinc-500 block">{label}</span>
      <span className={`text-lg font-semibold ${color || "text-zinc-100"}`}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-zinc-600 block mt-0.5">{sub}</span>}
    </div>
  );
}
