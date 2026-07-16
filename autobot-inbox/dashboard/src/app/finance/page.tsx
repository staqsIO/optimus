import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

interface FinanceSummary {
  currentMonth: string;
  revenue: number;
  expenses: { category: string; amount: number }[];
  totalExpenses: number;
  allocation: { operations: number; reserve: number; distribution: number };
  accounts: { operating: number; reserve: number };
}

interface CostDigest {
  date: string;
  totalSpend: number;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  invocations: Record<string, unknown>[];
}

interface DistributionGate {
  eligible: boolean;
  avgRevenue: number;
  avgExpenses: number;
  threshold: number;
  ratio: number;
}

function num(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

export default async function FinancePage() {
  const safe = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch { return null; }
  };

  const [summaryRes, modeRes, gateRes, digestRes] = await Promise.all([
    safe(() => apiFetch<{ summary: FinanceSummary }>("/api/finance/summary")),
    safe(() => apiFetch<{ mode: string }>("/api/finance/mode")),
    safe(() => apiFetch<{ gate: DistributionGate }>("/api/finance/distribution-gate")),
    safe(() => apiFetch<{ digest: CostDigest }>("/api/finance/cost-digest")),
  ]);
  const summary = summaryRes?.summary?.revenue !== undefined ? summaryRes.summary : null;
  const mode = modeRes?.mode ?? null;
  const gate = gateRes?.gate ?? null;
  const costDigest = digestRes?.digest ?? null;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold">Finance</h1>
        {mode != null && (
          <span
            className={`px-3 py-1 rounded text-xs font-semibold uppercase tracking-wider ${
              mode === "real"
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
            }`}
          >
            {mode} mode
          </span>
        )}
      </div>

      {/* Revenue / Expenses / Net Profit */}
      <section>
        <h2 className="text-lg font-semibold mb-4">
          Overview{summary?.currentMonth ? ` — ${summary.currentMonth}` : ""}
        </h2>
        {summary ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
              <div className="text-xs text-zinc-500 mb-1">Revenue</div>
              <div className="text-2xl font-bold text-status-approved">
                ${num(summary.revenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
              <div className="text-xs text-zinc-500 mb-1">Total Expenses</div>
              <div className="text-2xl font-bold text-status-action">
                ${num(summary.totalExpenses).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
              <div className="text-xs text-zinc-500 mb-1">Net Profit</div>
              <div
                className={`text-2xl font-bold ${
                  summary.revenue - summary.totalExpenses >= 0
                    ? "text-status-approved"
                    : "text-status-action"
                }`}
              >
                ${(num(summary.revenue) - num(summary.totalExpenses)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Financial summary data unavailable.
          </div>
        )}
      </section>

      {/* Expense Breakdown */}
      {summary?.expenses && summary.expenses.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Expense Breakdown</h2>
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                  <th className="px-6 py-3">Category</th>
                  <th className="px-6 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {summary.expenses.map((e) => (
                  <tr key={e.category}>
                    <td className="px-6 py-3 font-medium capitalize">{e.category}</td>
                    <td className="px-6 py-3 text-right text-zinc-400">
                      ${num(e.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Allocation Split (40/20/40) */}
      {summary?.allocation && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Allocation (40 / 20 / 40)</h2>
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
            <div className="flex h-6 rounded-full overflow-hidden">
              <div
                className="bg-blue-500 flex items-center justify-center text-xs font-medium"
                style={{ width: `${summary.allocation.operations}%` }}
              >
                {summary.allocation.operations}%
              </div>
              <div
                className="bg-yellow-500 flex items-center justify-center text-xs font-medium text-black"
                style={{ width: `${summary.allocation.reserve}%` }}
              >
                {summary.allocation.reserve}%
              </div>
              <div
                className="bg-green-500 flex items-center justify-center text-xs font-medium text-black"
                style={{ width: `${summary.allocation.distribution}%` }}
              >
                {summary.allocation.distribution}%
              </div>
            </div>
            <div className="flex justify-between mt-2 text-xs text-zinc-500">
              <span>Operations</span>
              <span>Reserve</span>
              <span>Distribution</span>
            </div>
          </div>
        </section>
      )}

      {/* Account Balances */}
      {summary?.accounts && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Accounts</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
              <div className="text-xs text-zinc-500 mb-1">Operating</div>
              <div className="text-2xl font-bold">
                ${num(summary.accounts.operating).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
              <div className="text-xs text-zinc-500 mb-1">Reserve</div>
              <div className="text-2xl font-bold">
                ${num(summary.accounts.reserve).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Cost Digest */}
      <section>
        <h2 className="text-lg font-semibold mb-4">
          Cost Digest{costDigest?.date ? ` — ${costDigest.date}` : ""}
        </h2>
        {costDigest ? (
          <div className="space-y-4">
            <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
              <div className="text-xs text-zinc-500 mb-1">Total Spend</div>
              <div className="text-2xl font-bold">
                ${num(costDigest.totalSpend).toFixed(4)}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* By Model */}
              <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
                <div className="px-6 py-3 border-b border-white/5">
                  <span className="text-sm font-semibold">Spend by Model</span>
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-white/5">
                    {Object.entries(costDigest.byModel).map(([model, cost]) => (
                      <tr key={model}>
                        <td className="px-6 py-2 text-zinc-400">{model}</td>
                        <td className="px-6 py-2 text-right">${Number(cost).toFixed(4)}</td>
                      </tr>
                    ))}
                    {Object.keys(costDigest.byModel).length === 0 && (
                      <tr>
                        <td className="px-6 py-2 text-zinc-500" colSpan={2}>No model data</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* By Agent */}
              <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
                <div className="px-6 py-3 border-b border-white/5">
                  <span className="text-sm font-semibold">Spend by Agent</span>
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-white/5">
                    {Object.entries(costDigest.byAgent).map(([agent, cost]) => (
                      <tr key={agent}>
                        <td className="px-6 py-2 text-zinc-400">{agent}</td>
                        <td className="px-6 py-2 text-right">${Number(cost).toFixed(4)}</td>
                      </tr>
                    ))}
                    {Object.keys(costDigest.byAgent).length === 0 && (
                      <tr>
                        <td className="px-6 py-2 text-zinc-500" colSpan={2}>No agent data</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Cost digest data unavailable.
          </div>
        )}
      </section>

      {/* Distribution Gate */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Distribution Gate</h2>
        {gate ? (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
            <div className="flex items-center gap-3 mb-4">
              <span
                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                  gate.eligible
                    ? "bg-green-500/20 text-green-400"
                    : "bg-red-500/20 text-red-400"
                }`}
              >
                {gate.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Avg Revenue</div>
                <div className="font-bold">
                  ${num(gate.avgRevenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1">Avg Expenses</div>
                <div className="font-bold">
                  ${num(gate.avgExpenses).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1">Threshold</div>
                <div className="font-bold">{gate.threshold}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1">Ratio</div>
                <div className="font-bold">{num(gate.ratio).toFixed(2)}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Distribution gate data unavailable.
          </div>
        )}
      </section>
    </div>
  );
}
