"use client";

import { useEffect, useState } from "react";
import { opsFetch } from "@/lib/ops-api";

interface AgentSpend {
  agent_id: string;
  cost_usd: number;
  invocations: number;
}

interface SpendResponse {
  totalUsd: number;
  invocations: number;
  activeAgents: number;
  byAgent: AgentSpend[];
  since?: string;
  note?: string;
}

const DAILY_BUDGET_USD = 20;

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export default function SpendToday() {
  const [data, setData] = useState<SpendResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await opsFetch<SpendResponse>("/api/audit/spend-today");
      if (cancelled) return;
      setData(result);
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) {
    return <span className="text-xs text-zinc-600 whitespace-nowrap">spend loading…</span>;
  }

  const pctOfBudget = Math.min(100, (data.totalUsd / DAILY_BUDGET_USD) * 100);
  const dotColor =
    pctOfBudget >= 90 ? "bg-red-400" : pctOfBudget >= 60 ? "bg-amber-400" : "bg-emerald-500";

  const tooltip = data.byAgent.length > 0
    ? `${data.invocations} call${data.invocations === 1 ? "" : "s"} across ${data.activeAgents} agent${data.activeAgents === 1 ? "" : "s"}\n` +
      data.byAgent
        .map((a) => `${a.agent_id}: ${formatUsd(a.cost_usd)} (${a.invocations})`)
        .join("\n")
    : "no LLM calls yet today";

  return (
    <div
      className="flex items-center gap-2 text-xs text-zinc-500 whitespace-nowrap"
      title={tooltip}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span>
        {formatUsd(data.totalUsd)} today
        {data.invocations > 0 && (
          <span className="text-zinc-600"> · {data.invocations} call{data.invocations === 1 ? "" : "s"}</span>
        )}
      </span>
    </div>
  );
}
