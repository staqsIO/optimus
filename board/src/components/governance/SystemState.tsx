"use client";

import { useState, useEffect } from "react";

interface SystemStateData {
  agents: Array<{ id: string; agent_type: string; model: string; is_active: boolean; tool_count: number }>;
  schemas: Array<{ schema: string; table_count: string }>;
  gates: Array<{ id: string; passing: boolean | null; value: unknown; threshold: unknown }>;
  budgets: Array<{ scope: string; allocated_usd: string; spent_usd: string }>;
  governance: Array<{ status: string; count: string }>;
  pipeline: Array<{ status: string; count: string }>;
  generated_at: string | null;
}

export default function SystemState() {
  const [data, setData] = useState<SystemStateData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch_data() {
      try {
        const res = await fetch("/api/governance?path=/api/governance/system-state");
        if (res.ok) {
          const d = await res.json();
          setData(d);
        }
      } catch {}
      setLoading(false);
    }
    fetch_data();
    const interval = setInterval(fetch_data, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="text-center py-4 text-zinc-500 text-sm">Loading system state...</div>;
  if (!data) return null;

  const totalGates = data.gates.length;
  const passingGates = data.gates.filter((g) => g.passing === true).length;
  const totalTables = data.schemas.reduce((sum, s) => sum + parseInt(s.table_count), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">System State</h2>
        {data.generated_at && (
          <span className="text-[10px] text-zinc-600">
            {new Date(data.generated_at).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Active Agents" value={String(data.agents.length)} />
        <StatCard
          label="Gates"
          value={`${passingGates}/${totalGates}`}
          color={passingGates === totalGates ? "text-emerald-400" : "text-amber-400"}
        />
        <StatCard label="Schemas" value={`${data.schemas.length} (${totalTables} tables)`} />
        <StatCard
          label="Budget"
          value={data.budgets.length > 0
            ? `$${parseFloat(data.budgets[0].spent_usd).toFixed(2)}/$${parseFloat(data.budgets[0].allocated_usd).toFixed(0)}`
            : "\u2014"
          }
        />
      </div>

      {/* Agent grid */}
      <div>
        <h3 className="text-xs font-medium text-zinc-400 mb-2">Agents</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {data.agents.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/30 rounded border border-white/5">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.is_active ? "bg-emerald-400" : "bg-zinc-600"}`} />
                <span className="text-xs text-zinc-300 truncate">{a.id}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[10px] text-zinc-500">{a.model.split('/').pop()}</span>
                <span className="text-[10px] text-zinc-600">{a.tool_count || 0}t</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pipeline + Governance stats */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs font-medium text-zinc-400 mb-2">Pipeline (7d)</h3>
          <div className="space-y-1">
            {data.pipeline.map((p) => (
              <div key={p.status} className="flex justify-between text-xs">
                <span className="text-zinc-400">{p.status}</span>
                <span className="text-zinc-300">{p.count}</span>
              </div>
            ))}
            {data.pipeline.length === 0 && <span className="text-xs text-zinc-600">No activity</span>}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-medium text-zinc-400 mb-2">Governance</h3>
          <div className="space-y-1">
            {data.governance.map((g) => (
              <div key={g.status} className="flex justify-between text-xs">
                <span className="text-zinc-400">{g.status.replace(/_/g, " ")}</span>
                <span className="text-zinc-300">{g.count}</span>
              </div>
            ))}
            {data.governance.length === 0 && <span className="text-xs text-zinc-600">No submissions</span>}
          </div>
        </div>
      </div>

      {/* Gates */}
      {data.gates.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-zinc-400 mb-2">Constitutional Gates</h3>
          <div className="flex flex-wrap gap-1.5">
            {data.gates.map((g) => (
              <span
                key={g.id}
                className={`px-2 py-0.5 text-[10px] rounded-full border ${
                  g.passing === true
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                    : g.passing === false
                    ? "bg-red-500/10 text-red-300 border-red-500/20"
                    : "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
                }`}
              >
                {g.id}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="px-3 py-2 bg-zinc-800/30 rounded-lg border border-white/5">
      <span className="text-[10px] text-zinc-500 block">{label}</span>
      <span className={`text-sm font-medium ${color || "text-zinc-200"}`}>{value}</span>
    </div>
  );
}
