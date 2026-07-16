"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { opsFetch } from "@/lib/ops-api";

interface TopologyNode {
  id: string;
  tier: string;
  model: string;
  recentTasks: number;
  recentSuccesses: number;
  capabilities: string[];
}

interface TopologyEdge {
  source: string;
  target: string;
  successRate: number | null;
}

interface TopologyData {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  source: "neo4j" | "postgres" | "unavailable";
}

import { getAgentDisplay, formatModelLabel } from "@/lib/agent-display";

const TIER_ORDER: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };

function healthColor(pct: number | null): string {
  if (pct === null) return "text-zinc-500";
  if (pct >= 90) return "text-emerald-400";
  if (pct >= 70) return "text-amber-400";
  return "text-red-400";
}

function healthBg(pct: number | null): string {
  if (pct === null) return "bg-zinc-500/10";
  if (pct >= 90) return "bg-emerald-400/10";
  if (pct >= 70) return "bg-amber-400/10";
  return "bg-red-400/10";
}

function edgeColor(rate: number | null): string {
  if (rate === null) return "bg-zinc-700";
  if (rate >= 0.8) return "bg-emerald-500/40";
  if (rate >= 0.5) return "bg-amber-500/40";
  return "bg-red-500/40";
}

export default function OrgTopologyPanel() {
  const [data, setData] = useState<TopologyData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await opsFetch<TopologyData>("/api/governance/topology");
    if (result) setData(result);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const sortedNodes = useMemo(() => {
    if (!data?.nodes) return [];
    return [...data.nodes].sort((a, b) => {
      const tierA = TIER_ORDER[a.tier] ?? 99;
      const tierB = TIER_ORDER[b.tier] ?? 99;
      if (tierA !== tierB) return tierA - tierB;
      return b.recentTasks - a.recentTasks;
    });
  }, [data]);

  // Edges where hovered agent is source or target
  const relevantEdges = useMemo(() => {
    if (!hoveredAgent || !data?.edges) return [];
    return data.edges.filter(e => e.source === hoveredAgent || e.target === hoveredAgent);
  }, [hoveredAgent, data]);

  const connectedAgents = useMemo(() => {
    return new Set(relevantEdges.flatMap(e => [e.source, e.target]));
  }, [relevantEdges]);

  if (!data || data.source === "unavailable") {
    return (
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-600" />
          <span>Knowledge graph offline</span>
        </div>
      </div>
    );
  }

  if (sortedNodes.length === 0) return null;

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center justify-between p-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span className="font-medium">Org Topology</span>
          <span className="px-1.5 py-0.5 text-[9px] bg-white/5 text-zinc-500 rounded-full">
            {sortedNodes.length} agents
          </span>
          {data.source === "postgres" && (
            <span className="px-1.5 py-0.5 text-[9px] bg-amber-500/10 text-amber-400 rounded-full">
              pg fallback
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {sortedNodes.map(n => {
            const pct = n.recentTasks > 0 ? Math.round((n.recentSuccesses / n.recentTasks) * 100) : null;
            return (
              <div
                key={n.id}
                className={`w-2 h-2 rounded-full ${pct === null ? "bg-zinc-600" : pct >= 90 ? "bg-emerald-400" : pct >= 70 ? "bg-amber-400" : "bg-red-400"}`}
                title={`${getAgentDisplay(n.id).displayName}: ${pct ?? "?"}%`}
              />
            );
          })}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {sortedNodes.map(node => {
            const persona = getAgentDisplay(node.id);
            const pct = node.recentTasks > 0 ? Math.round((node.recentSuccesses / node.recentTasks) * 100) : null;
            const isHighlighted = hoveredAgent === null || connectedAgents.has(node.id) || hoveredAgent === node.id;
            const outEdges = data.edges.filter(e => e.source === node.id);

            return (
              <div
                key={node.id}
                className={`flex items-center gap-2 py-1.5 px-2 rounded-md transition-opacity ${
                  isHighlighted ? "hover:bg-white/[0.02]" : "opacity-30"
                }`}
                onMouseEnter={() => setHoveredAgent(node.id)}
                onMouseLeave={() => setHoveredAgent(null)}
              >
                <div className={`w-7 h-7 ${persona.color} rounded-full flex items-center justify-center text-white font-semibold text-[10px] flex-shrink-0`}>
                  {persona.initials}

                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium ${persona.textColor}`}>{persona.displayName}</span>
                    <span className="text-[9px] text-zinc-600">{formatModelLabel(node.model)}</span>
                  </div>
                  {outEdges.length > 0 && hoveredAgent === node.id && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[9px] text-zinc-600">delegates to:</span>
                      {outEdges.map(e => {
                        const targetDisplay = getAgentDisplay(e.target);
                        const rate = e.successRate !== null ? Math.round(e.successRate * 100) : null;
                        return (
                          <span key={e.target} className="flex items-center gap-0.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${edgeColor(e.successRate)}`} />
                            <span className="text-[9px] text-zinc-500">
                              {targetDisplay.displayName}
                              {rate !== null && ` ${rate}%`}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px]">
                  {node.recentTasks > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                      {node.recentTasks} 7d
                    </span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded ${healthBg(pct)} ${healthColor(pct)}`}>
                    {pct !== null ? `${pct}%` : "no data"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
