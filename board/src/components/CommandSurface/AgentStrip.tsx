"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useEventStream, EventStreamEvent } from "@/hooks/useEventStream";

interface AgentStatus {
  online: boolean;
  enabled: boolean;
  status: string;
  tier: string | null;
  subTier: string | null;
  model: string | null;
  lastSeen: string | null;
  currentTask: { id: string; title: string; type: string } | null;
  pid: number | null;
}

const TIER_COLORS: Record<string, string> = {
  Strategist: "text-purple-400",
  Architect: "text-emerald-400",
  Orchestrator: "text-blue-400",
  Reviewer: "text-amber-400",
  Executor: "text-zinc-400",
  Utility: "text-gray-500",
  External: "text-cyan-400",
};

export default function AgentStrip() {
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const fetchStatuses = useCallback(async () => {
    const data = await opsFetch<{ statuses: Record<string, AgentStatus> }>("/api/agents/status");
    if (data?.statuses) setStatuses(data.statuses);
  }, []);

  // Initial load
  useEffect(() => { fetchStatuses(); }, [fetchStatuses]);

  // Refresh on agent toggle events
  useEventStream("agent_toggled", useCallback(() => {
    fetchStatuses();
  }, [fetchStatuses]));

  // Refresh on state changes
  useEventStream("state_changed", useCallback(() => {
    fetchStatuses();
  }, [fetchStatuses]));

  async function toggleAgent(agentId: string) {
    setToggling((prev) => ({ ...prev, [agentId]: true }));
    await opsPost("/api/agents/toggle", { agentId });
    await fetchStatuses();
    setToggling((prev) => ({ ...prev, [agentId]: false }));
  }

  const agents = Object.entries(statuses).sort(([, a], [, b]) => {
    // Sort: online first, then by tier
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return 0;
  });

  if (agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        Loading agents...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-0.5 p-2">
        {agents.map(([id, agent]) => (
          <div
            key={id}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
              agent.online ? "hover:bg-white/[0.03]" : "opacity-50"
            }`}
          >
            {/* Status dot */}
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                agent.status === "processing" ? "bg-blue-500 animate-pulse" :
                agent.online ? "bg-emerald-500" :
                agent.enabled ? "bg-yellow-500" :
                "bg-zinc-600"
              }`}
            />

            {/* Agent info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <Link
                  href={`/agents/${id}`}
                  className="text-sm text-zinc-200 hover:text-white transition-colors truncate"
                >
                  {id}
                </Link>
                {agent.tier && (
                  <span className={`text-[10px] ${TIER_COLORS[agent.tier] || "text-zinc-500"}`}>
                    {agent.tier}
                  </span>
                )}
              </div>
              {agent.currentTask ? (
                <div className="text-[10px] text-zinc-500 truncate">
                  {agent.currentTask.title}
                </div>
              ) : agent.model ? (
                <div className="text-[10px] text-zinc-600">
                  {agent.model}
                </div>
              ) : null}
            </div>

            {/* Toggle switch */}
            <button
              onClick={() => toggleAgent(id)}
              disabled={toggling[id]}
              className={`w-8 h-4 rounded-full transition-colors shrink-0 ${
                agent.enabled ? "bg-emerald-600" : "bg-zinc-700"
              } ${toggling[id] ? "opacity-50" : ""}`}
              title={agent.enabled ? "Disable agent" : "Enable agent"}
            >
              <div
                className={`w-3 h-3 rounded-full bg-white transition-transform ${
                  agent.enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
