"use client";

import { useState, useEffect } from "react";
import { opsFetch } from "@/lib/ops-api";

interface AgentStatus {
  id: string;
  online: boolean;
  enabled: boolean;
  status: string;
  tier: string;
  model: string;
  lastSeen: string | null;
}

export default function AgentStatusWidget() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);

  useEffect(() => {
    const load = () =>
      opsFetch<{ agents: Record<string, AgentStatus> }>("/api/agents/status")
        .then((data) => {
          if (data?.agents) {
            setAgents(
              Object.entries(data.agents)
                .map(([id, a]) => ({ ...a, id }))
                .filter((a) => a.enabled && a.tier !== "External")
                .sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1))
            );
          }
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const online = agents.filter((a) => a.online).length;

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-300">Agent Status</h3>
        <span className="text-xs text-zinc-500">{online}/{agents.length} online</span>
      </div>
      <div className="space-y-1.5">
        {agents.slice(0, 8).map((a) => (
          <div key={a.id} className="flex items-center gap-2 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.online ? "bg-emerald-400" : "bg-zinc-600"}`} />
            <span className="text-zinc-300 truncate flex-1">{a.id}</span>
            <span className="text-zinc-600 text-[10px]">{a.tier}</span>
          </div>
        ))}
        {agents.length > 8 && (
          <div className="text-[10px] text-zinc-600">+{agents.length - 8} more</div>
        )}
      </div>
    </div>
  );
}
