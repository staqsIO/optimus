import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

interface StatsResponse {
  agents: Record<string, unknown>[];
  budget: Record<string, unknown>[];
  stats: Record<string, unknown> | null;
  costHistory: Record<string, unknown>[];
}

export default async function StatsPage() {
  let agents: Record<string, unknown>[] = [];
  let budget: Record<string, unknown>[] = [];
  let stats: Record<string, unknown> | null = null;
  try {
    const data = await apiFetch<StatsResponse>("/api/stats");
    agents = data?.agents || [];
    budget = data?.budget || [];
    stats = data?.stats ?? null;
  } catch { /* API timeout or unavailable */ }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">System Stats</h1>

      {/* Budget */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Budget</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {budget?.map((b) => {
            const pct = parseFloat(String(b.utilization_pct ?? 0));
            return (
              <div
                key={b.id as string}
                className="bg-surface-raised rounded-lg p-4 border border-white/5"
              >
                <div className="text-xs text-zinc-500 mb-1 capitalize">
                  {b.scope as string}
                </div>
                <div className="flex items-end gap-2">
                  <span
                    className={`text-xl font-bold ${pct > 80 ? "text-status-action" : pct > 50 ? "text-status-response" : "text-status-approved"}`}
                  >
                    ${parseFloat(String(b.spent_usd)).toFixed(2)}
                  </span>
                  <span className="text-sm text-zinc-500">
                    / ${parseFloat(String(b.allocated_usd)).toFixed(2)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${pct > 80 ? "bg-status-action" : pct > 50 ? "bg-status-response" : "bg-status-approved"}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {(!budget || budget.length === 0) && (
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
              No budget data available.
            </div>
          )}
        </div>
      </section>

      {/* Agent Activity */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Agent Activity (Today)</h2>
        <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                <th className="px-6 py-3">Agent</th>
                <th className="px-6 py-3 text-right">Calls</th>
                <th className="px-6 py-3 text-right">Cost</th>
                <th className="px-6 py-3 text-right">Tokens</th>
                <th className="px-6 py-3 text-right">Active</th>
                <th className="px-6 py-3 text-right">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {agents?.map((a) => (
                <tr key={a.agent_id as string}>
                  <td className="px-6 py-3 font-medium">
                    {a.agent_id as string}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {a.calls_today as number}
                  </td>
                  <td className="px-6 py-3 text-right">
                    ${parseFloat(String(a.cost_today_usd)).toFixed(4)}
                  </td>
                  <td className="px-6 py-3 text-right text-zinc-400">
                    {Number(a.tokens_today).toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {a.active_tasks as number}
                  </td>
                  <td className="px-6 py-3 text-right text-status-approved">
                    {a.completed_today as number}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Autonomy Metrics */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Autonomy Level: L0</h2>
        <div className="bg-surface-raised rounded-lg p-6 border border-white/5">
          <p className="text-sm text-zinc-400 mb-4">
            Full HITL — all drafts require board approval. Tracking exit
            criteria for L1.
          </p>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <div className="text-xs text-zinc-500 mb-1">
                Drafts Reviewed (14d)
              </div>
              <div className="text-lg font-bold">
                {Number(stats?.drafts_reviewed_14d ?? 0)}{" "}
                <span className="text-sm text-zinc-500">/ 50</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">
                Edit Rate (14d)
              </div>
              <div className="text-lg font-bold">
                {String(stats?.edit_rate_14d_pct ?? "—")}%{" "}
                <span className="text-sm text-zinc-500">
                  target &lt;10%
                </span>
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">Minimum Days</div>
              <div className="text-lg font-bold">
                0 <span className="text-sm text-zinc-500">/ 14</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
