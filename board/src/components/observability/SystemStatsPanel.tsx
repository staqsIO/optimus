"use client";

/**
 * SystemStatsPanel — per-agent cost/tokens, budget utilization, L0 exit criteria.
 * Parity with CLI `stats` command.
 */

import { useEffect, useState } from "react";
import { num, CriterionBar } from "@/components/shared/stats-helpers";

interface AgentStat {
  agent_id: string;
  agent_type?: string;
  model?: string;
  calls_today: number | string;
  cost_today_usd: number | string;
  tokens_today: number | string;
  active_tasks: number | string;
  completed_today: number | string;
}

interface BudgetStat {
  scope: string;
  scope_id?: string | null;
  allocated_usd: number | string;
  spent_usd: number | string;
  reserved_usd?: number | string;
  remaining_usd?: number | string;
  utilization_pct: number | string;
}

interface StatsResponse {
  agents: AgentStat[];
  budget: BudgetStat[];
  stats: {
    drafts_reviewed_14d?: number | string;
    edit_rate_14d_pct?: number | string;
    halt_active?: boolean;
  } | null;
}

export default function SystemStatsPanel() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchStats() {
      try {
        const res = await fetch("/api/inbox-proxy?path=/api/stats");
        if (res.ok && !cancelled) {
          const d = await res.json();
          setData(d);
        }
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    }
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) {
    return <div className="h-40 rounded-lg bg-surface-raised border border-white/5 animate-pulse" />;
  }
  if (!data) return null;

  const agents = (data.agents || []).slice().sort(
    (a, b) => num(b.cost_today_usd) - num(a.cost_today_usd),
  );
  const budgets = data.budget || [];
  const reviewed = num(data.stats?.drafts_reviewed_14d);
  const editRate = num(data.stats?.edit_rate_14d_pct);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Per-agent cost + tokens */}
      <div className="lg:col-span-2 bg-surface-raised rounded-lg border border-white/5">
        <div className="p-4 border-b border-white/5">
          <h2 className="text-sm font-semibold text-zinc-300">Agent Activity (today)</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Calls, cost, tokens — sorted by cost
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-zinc-500 bg-zinc-900/40">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Agent</th>
                <th className="text-right px-3 py-2 font-medium">Calls</th>
                <th className="text-right px-3 py-2 font-medium">Cost</th>
                <th className="text-right px-3 py-2 font-medium">Tokens</th>
                <th className="text-right px-3 py-2 font-medium">Active</th>
                <th className="text-right px-3 py-2 font-medium">Done</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-4 text-zinc-600">
                    No agent activity yet today.
                  </td>
                </tr>
              )}
              {agents.map((a) => (
                <tr key={a.agent_id} className="border-t border-white/5 hover:bg-white/[0.02]">
                  <td className="px-3 py-1.5 text-zinc-300 font-medium">
                    {a.agent_id}
                    {a.model && (
                      <span className="ml-2 text-[10px] text-zinc-600">
                        {a.model.split("/").pop()}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                    {num(a.calls_today)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                    ${num(a.cost_today_usd).toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {num(a.tokens_today).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {num(a.active_tasks)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {num(a.completed_today)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Budget + L0 */}
      <div className="space-y-4">
        <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Budget Utilization</h2>
          <div className="space-y-3">
            {budgets.length === 0 && (
              <div className="text-xs text-zinc-600">No budgets configured.</div>
            )}
            {budgets.map((b) => {
              const pct = num(b.utilization_pct);
              const spent = num(b.spent_usd);
              const allocated = num(b.allocated_usd);
              const barColor =
                pct > 80 ? "bg-red-400/80" : pct > 50 ? "bg-amber-400/80" : "bg-emerald-400/80";
              const textColor =
                pct > 80 ? "text-red-300" : pct > 50 ? "text-amber-300" : "text-emerald-300";
              return (
                <div key={`${b.scope}-${b.scope_id || ""}`}>
                  <div className="flex items-baseline justify-between text-xs mb-1">
                    <span className="text-zinc-400 capitalize">
                      {b.scope}
                      {b.scope_id && <span className="text-zinc-600"> · {b.scope_id}</span>}
                    </span>
                    <span className="tabular-nums text-zinc-500">
                      <span className={textColor}>${spent.toFixed(2)}</span>
                      {" / "}
                      <span>${allocated.toFixed(0)}</span>
                      {" "}
                      <span className={textColor}>({pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className={`h-full ${barColor} transition-all`}
                      style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
          <h2 className="text-sm font-semibold text-zinc-300 mb-1">Autonomy</h2>
          <div className="text-xs text-zinc-500 mb-3">
            Level L0 (Full HITL) — L0 exit criteria (14-day rolling)
          </div>
          <div className="space-y-3">
            <CriterionBar
              label="Edit rate"
              valueText={`${editRate.toFixed(1)}%`}
              target="target <10%"
              pct={Math.min(100, editRate * 10)}
              pass={editRate < 10 && reviewed >= 50}
              inverted
            />
            <CriterionBar
              label="Drafts reviewed"
              valueText={`${reviewed} / 50`}
              target="≥ 50"
              pct={Math.min(100, (reviewed / 50) * 100)}
              pass={reviewed >= 50}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

