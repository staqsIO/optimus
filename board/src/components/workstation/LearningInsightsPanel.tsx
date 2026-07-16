"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

interface PatternSummary {
  pattern_type: string;
  count: number;
  avg_confidence: number;
  last_extracted: string;
}

interface TopPattern {
  agent_id: string;
  pattern_type: string;
  description: string;
  metric_value: number;
  confidence: number;
  sample_size: number;
  created_at: string;
}

interface AgentCoverage {
  agent_id: string;
  pattern_types: number;
  total_samples: number;
}

interface PatternsData {
  summary: PatternSummary[];
  topPatterns: TopPattern[];
  agentCoverage: AgentCoverage[];
}

const PATTERN_LABELS: Record<string, string> = {
  success_rate: "Success Rate",
  delegation_path: "Delegation",
  cost_efficiency: "Cost",
  duration_trend: "Duration",
  failure_mode: "Failures",
  time_of_day: "Time-of-Day",
  thread_depth: "Thread Depth",
  sender_type: "Sender Type",
};

import { formatAgentId } from "@/lib/agent-display";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function confidenceBar(confidence: number) {
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 70
      ? "bg-emerald-400"
      : pct >= 40
        ? "bg-amber-400"
        : "bg-zinc-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[9px] text-zinc-500">{pct}%</span>
    </div>
  );
}

export default function LearningInsightsPanel() {
  const [data, setData] = useState<PatternsData | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const result = await opsFetch<PatternsData>("/api/governance/patterns");
    if (result) setData(result);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const totalPatterns =
    data?.summary?.reduce(
      (a, s) => a + parseInt(String(s.count), 10),
      0
    ) || 0;
  const lastExtracted = data?.summary?.[0]?.last_extracted;

  if (!data || totalPatterns === 0) {
    return (
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-600" />
          <span>Learning system -- no patterns extracted yet</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between p-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px]">
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
          <span className="font-medium">Learning Insights</span>
          <span className="px-1.5 py-0.5 text-[9px] bg-white/5 text-zinc-500 rounded-full">
            {totalPatterns} patterns
          </span>
          {lastExtracted && (
            <span className="text-[9px] text-zinc-600">
              updated {timeAgo(lastExtracted)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(data.agentCoverage || []).map((a) => (
            <div
              key={a.agent_id}
              className={`w-2 h-2 rounded-full ${
                parseInt(String(a.pattern_types), 10) >= 4
                  ? "bg-emerald-400"
                  : parseInt(String(a.pattern_types), 10) >= 2
                    ? "bg-amber-400"
                    : "bg-zinc-600"
              }`}
              title={`${formatAgentId(a.agent_id)}: ${a.pattern_types} pattern types`}
            />
          ))}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Pattern type summary */}
          <div className="grid grid-cols-4 gap-1.5">
            {(data.summary || []).map((s) => (
              <div
                key={s.pattern_type}
                className="px-2 py-1.5 rounded bg-white/[0.02] border border-white/5"
              >
                <div className="text-[9px] text-zinc-500">
                  {PATTERN_LABELS[s.pattern_type] || s.pattern_type}
                </div>
                <div className="text-xs text-zinc-300 font-medium">
                  {s.count}
                </div>
                {confidenceBar(parseFloat(String(s.avg_confidence)) || 0)}
              </div>
            ))}
          </div>

          {/* Agent coverage */}
          <div>
            <div className="text-[10px] text-zinc-500 mb-1.5 font-medium">
              Agent Coverage
            </div>
            <div className="space-y-1">
              {(data.agentCoverage || []).map((a) => (
                <div
                  key={a.agent_id}
                  className="flex items-center gap-2 text-[10px]"
                >
                  <span className="text-zinc-400 w-16 truncate">
                    {formatAgentId(a.agent_id)}
                  </span>
                  <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-400/60 rounded-full"
                      style={{
                        width: `${Math.min(100, (parseInt(String(a.pattern_types), 10) / 8) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-zinc-600">
                    {a.pattern_types} types / {a.total_samples} samples
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Top patterns */}
          <div>
            <div className="text-[10px] text-zinc-500 mb-1.5 font-medium">
              Top Patterns (by confidence)
            </div>
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {(data.topPatterns || []).slice(0, 10).map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-white/[0.02] text-[10px]"
                >
                  <span className="px-1 py-0.5 rounded bg-white/5 text-zinc-500 text-[8px] uppercase">
                    {PATTERN_LABELS[p.pattern_type]?.slice(0, 4) ||
                      p.pattern_type.slice(0, 4)}
                  </span>
                  <span className="flex-1 text-zinc-400 truncate">
                    {p.description}
                  </span>
                  <span className="text-zinc-600">n={p.sample_size}</span>
                  {confidenceBar(parseFloat(String(p.confidence)) || 0)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
