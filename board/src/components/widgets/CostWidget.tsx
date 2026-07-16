"use client";

import { useState, useEffect } from "react";
import { opsFetch } from "@/lib/ops-api";

interface StatsData {
  agents: { agent_id: string; cost_today_usd: number }[];
  budget: { allocated_usd: string; spent_usd: string; remaining_usd: string }[];
}

interface CostData {
  today_spend: number;
  budget_remaining: number;
  budget_allocated: number;
}

function extractCost(stats: StatsData | null): CostData | null {
  if (!stats) return null;
  const today_spend = stats.agents?.reduce((s, a) => s + (Number(a.cost_today_usd) || 0), 0) || 0;
  const b = stats.budget?.[0];
  return {
    today_spend,
    budget_allocated: b ? Number(b.allocated_usd) || 20 : 20,
    budget_remaining: b ? Number(b.remaining_usd) || 20 : 20,
  };
}

export default function CostWidget() {
  const [cost, setCost] = useState<CostData | null>(null);

  useEffect(() => {
    const load = () =>
      opsFetch<StatsData>("/api/stats")
        .then((data) => setCost(extractCost(data)))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const pct = cost && cost.budget_allocated > 0
    ? Math.min(100, ((cost.budget_allocated - cost.budget_remaining) / cost.budget_allocated) * 100)
    : 0;

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
      <h3 className="text-sm font-medium text-zinc-300 mb-3">Cost (24h)</h3>
      {cost ? (
        <div className="space-y-3">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-400">Today</span>
            <span className="text-zinc-200 font-mono">${cost.today_spend.toFixed(2)}</span>
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
              <span>Budget</span>
              <span>${(cost.budget_allocated - cost.budget_remaining).toFixed(2)} / ${cost.budget_allocated.toFixed(2)}</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="text-xs text-zinc-600">Loading cost data...</div>
      )}
    </div>
  );
}
