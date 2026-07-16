"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";
import { getAgentDisplay, formatAgentId } from "@/lib/agent-display";
import type { RunSummary } from "@/components/runs/types";

const STATUS_COLORS: Record<string, string> = {
  created: "bg-zinc-500",
  assigned: "bg-blue-500",
  in_progress: "bg-amber-500",
  review: "bg-purple-500",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  blocked: "bg-orange-500",
  timed_out: "bg-rose-500",
  cancelled: "bg-zinc-600",
};

const TRIGGER_ICONS: Record<string, string> = {
  gmail: "\u2709",
  email: "\u2709",
  linear: "\u25a0",
  github: "\u2b22",
  slack: "#",
  telegram: "\u2708",
  board: "\u229a",
  drive: "\ud83d\udcc4",
};

function getTriggerIcon(source: string): string {
  const lower = source.toLowerCase();
  for (const [key, icon] of Object.entries(TRIGGER_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return "\u25cf";
}

const TIME_RANGES = [
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 604_800_000 },
  { label: "30d", ms: 2_592_000_000 },
  { label: "All", ms: 0 },
];

const STATUSES = ["all", "in_progress", "completed", "failed", "cancelled", "blocked"];

function formatDuration(ms: string | number | null): string {
  if (!ms) return "--";
  const val = typeof ms === "string" ? parseFloat(ms) : ms;
  if (val < 1000) return `${Math.round(val)}ms`;
  if (val < 60_000) return `${(val / 1000).toFixed(1)}s`;
  if (val < 3_600_000) return `${Math.round(val / 60_000)}m`;
  return `${(val / 3_600_000).toFixed(1)}h`;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [timeRange, setTimeRange] = useState(604_800_000); // 7d
  const [liveMode, setLiveMode] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRuns = useCallback(async () => {
    const params = new URLSearchParams({ limit: "100" });
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (timeRange > 0) {
      params.set("since", new Date(Date.now() - timeRange).toISOString());
    }
    const data = await opsFetch<{ runs: RunSummary[] }>(`/api/runs?${params}`);
    if (data?.runs) {
      setRuns(data.runs);
    }
    setLoading(false);
  }, [statusFilter, timeRange]);

  useEffect(() => {
    setLoading(true);
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (liveMode) {
      intervalRef.current = setInterval(fetchRuns, 5_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [liveMode, fetchRuns]);

  return (
    <div className="h-[calc(100vh-49px)] flex flex-col bg-[#0a0a0f]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-zinc-200">Runs</h1>

          {/* Status filter */}
          <div className="flex items-center gap-1">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2 py-1 text-[10px] rounded transition-colors ${
                  statusFilter === s
                    ? "bg-white/10 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {s === "all" ? "All" : s.replace("_", " ")}
              </button>
            ))}
          </div>

          {/* Time range */}
          <div className="flex items-center gap-1 ml-2">
            {TIME_RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setTimeRange(r.ms)}
                className={`px-2 py-1 text-[10px] rounded transition-colors ${
                  timeRange === r.ms
                    ? "bg-white/10 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={`px-2 py-1 text-[10px] rounded transition-colors ${
              liveMode
                ? "bg-emerald-500/20 text-emerald-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {liveMode ? "\u25cf Live" : "\u25cb Live"}
          </button>
          <span className="text-[10px] text-zinc-600 tabular-nums">
            {runs.length} runs
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading && runs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
            Loading...
          </div>
        ) : runs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
            No runs found
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/5 text-zinc-500">
                <th className="text-left py-2.5 px-4 font-medium">Trigger</th>
                <th className="text-left py-2.5 px-4 font-medium">Title</th>
                <th className="text-left py-2.5 px-4 font-medium">Status</th>
                <th className="text-right py-2.5 px-4 font-medium">Items</th>
                <th className="text-right py-2.5 px-4 font-medium">Agents</th>
                <th className="text-right py-2.5 px-4 font-medium">Cost</th>
                <th className="text-right py-2.5 px-4 font-medium">Duration</th>
                <th className="text-right py-2.5 px-4 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const cost = parseFloat(run.total_cost_usd);
                return (
                  <tr
                    key={run.id}
                    className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <span className="text-base mr-1.5" title={run.trigger_source}>
                        {getTriggerIcon(run.trigger_source)}
                      </span>
                      <span className="text-zinc-500 text-[10px]">{run.trigger_source}</span>
                    </td>
                    <td className="py-2.5 px-4">
                      <Link
                        href={`/runs/${run.id}`}
                        className="text-zinc-200 hover:text-accent-bright transition-colors truncate block max-w-[300px]"
                      >
                        {run.title}
                      </Link>
                    </td>
                    <td className="py-2.5 px-4">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[run.status] || "bg-zinc-500"}`}
                        />
                        <span className="text-zinc-400">{run.status.replace("_", " ")}</span>
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right text-zinc-400 tabular-nums">
                      {run.item_count}
                    </td>
                    <td className="py-2.5 px-4 text-right text-zinc-400 tabular-nums">
                      {run.agent_count}
                    </td>
                    <td className="py-2.5 px-4 text-right text-zinc-400 tabular-nums">
                      {cost > 0 ? (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`) : "--"}
                    </td>
                    <td className="py-2.5 px-4 text-right text-zinc-400 tabular-nums">
                      {formatDuration(run.duration_ms)}
                    </td>
                    <td className="py-2.5 px-4 text-right text-zinc-500">
                      {new Date(run.created_at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
