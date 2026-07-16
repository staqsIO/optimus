"use client";

import { useEffect, useState, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

// ── Types ──────────────────────────────────────────────────────────────────

interface TaskTrace {
  task: {
    id: string;
    type: string;
    title: string;
    description: string | null;
    status: string;
    assigned_to: string | null;
    created_by: string;
    priority: number;
    budget_usd: string | null;
    created_at: string;
    updated_at: string;
  };
  events: TraceEvent[];
  metrics: {
    total_cost_usd: number;
    total_tokens: number;
    duration_ms: number | null;
    event_count: number;
    step_count: number;
    total_step_count: number;
    truncated: boolean;
    transition_count: number;
  };
}

interface TraceEvent {
  id: string;
  event_type: string;
  agent_id: string | null;
  label: string;
  detail: string | null;
  metadata: Record<string, unknown> | null;
  cost_usd: number | null;
  tokens: number | null;
  created_at: string;
  duration_ms: number | null;
  status: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  state_transition:    "⇢",
  task_execution:      "▶",
  llm_call:            "◆",
  cli_llm_call:        "◆",
  planning:            "◇",
  strategy_execution:  "◈",
  quality_check:       "◉",
  decision:            "◎",
  campaign_iteration:  "↻",
  context_load:        "↓",
  gate_check:          "⚑",
  work_item_create:    "+",
  cli_tool_use:        "⚒",
  cli_subagent:        "⇢",
};

const STATUS_COLORS: Record<string, string> = {
  in_progress: "text-yellow-400",
  completed:   "text-emerald-400",
  failed:      "text-red-400",
};

const STATUS_DOT: Record<string, string> = {
  in_progress: "bg-yellow-400 animate-pulse",
  completed:   "bg-emerald-500",
  failed:      "bg-red-500",
};

const AGENT_COLORS: Record<string, string> = {
  orchestrator:         "text-violet-400",
  strategist:           "text-blue-400",
  "executor-triage":    "text-cyan-400",
  "executor-responder": "text-teal-400",
  "executor-ticket":    "text-orange-400",
  "executor-coder":     "text-yellow-300",
  "executor-research":  "text-indigo-400",
  "executor-redesign":  "text-pink-400",
  "executor-blueprint": "text-rose-400",
  reviewer:             "text-lime-400",
  architect:            "text-amber-400",
  "claw-campaigner":    "text-purple-400",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

// ── EventRow ───────────────────────────────────────────────────────────────

function EventRow({ event }: { event: TraceEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(event.detail || (event.metadata && Object.keys(event.metadata).length > 0));
  const icon = EVENT_ICONS[event.event_type] ?? "·";
  const agentColor = AGENT_COLORS[event.agent_id ?? ""] ?? "text-zinc-400";
  const isTransition = event.event_type === "state_transition";

  return (
    <div>
      <div
        className={`flex items-start gap-2 px-3 py-1.5 hover:bg-white/[0.03] group
                    ${hasDetail ? "cursor-pointer" : ""}`}
        onClick={() => hasDetail && setExpanded(!expanded)}
      >
        {/* Status dot */}
        <div className="mt-1.5 shrink-0">
          <div className={`w-1.5 h-1.5 rounded-full ${
            isTransition ? "bg-zinc-500" : STATUS_DOT[event.status] ?? "bg-zinc-600"
          }`} />
        </div>

        {/* Icon */}
        <span className={`shrink-0 text-xs font-mono mt-0.5 w-3 ${
          isTransition ? "text-zinc-600" : "text-zinc-500"
        }`}>{icon}</span>

        {/* Label */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-xs font-mono ${
              isTransition
                ? "text-zinc-500"
                : STATUS_COLORS[event.status] ?? "text-zinc-400"
            }`}>
              {event.label}
            </span>
            {hasDetail && (
              <span className="text-zinc-700 text-xs leading-none select-none">
                {expanded ? "▾" : "▸"}
              </span>
            )}
          </div>
        </div>

        {/* Right: agent + cost + duration + time */}
        <div className="flex items-center gap-2 shrink-0 text-xs">
          {event.agent_id && (
            <span className={`${agentColor} opacity-60 group-hover:opacity-100 font-mono`}>
              {event.agent_id}
            </span>
          )}
          {event.cost_usd !== null && event.cost_usd > 0 && (
            <span className="text-zinc-600 tabular-nums font-mono">
              {formatCost(event.cost_usd)}
            </span>
          )}
          <span className="text-zinc-700 tabular-nums w-14 text-right font-mono">
            {formatDuration(event.duration_ms)}
          </span>
          <span className="text-zinc-700 tabular-nums w-16 text-right font-mono">
            {formatTime(event.created_at)}
          </span>
        </div>
      </div>

      {expanded && hasDetail && (
        <div className="px-8 pb-2">
          {event.detail && (
            <p className="text-xs text-zinc-500 mb-1">{event.detail}</p>
          )}
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <pre className="text-xs text-zinc-500 bg-black/30 rounded p-2 overflow-x-auto">
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── TaskTracePanel ─────────────────────────────────────────────────────────

interface TaskTracePanelProps {
  taskId: string;
  onClose: () => void;
}

export default function TaskTracePanel({ taskId, onClose }: TaskTracePanelProps) {
  const [trace, setTrace] = useState<TaskTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrace = useCallback(async () => {
    setLoading(true);
    setError(null);
    const data = await opsFetch<TaskTrace | { error: string }>(
      `/api/tasks/trace?task_id=${encodeURIComponent(taskId)}`
    );
    if (!data) {
      setError("Failed to load trace");
    } else if ("error" in data) {
      setError(data.error);
    } else {
      setTrace(data);
    }
    setLoading(false);
  }, [taskId]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trace-panel-title"
        className="fixed right-0 top-0 h-full w-[560px] max-w-full bg-zinc-950 border-l border-white/10 z-50 flex flex-col shadow-2xl"
      >

        {/* Header */}
        <div className="flex items-start gap-3 px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex-1 min-w-0">
            {loading ? (
              <div className="h-4 w-48 bg-white/5 rounded animate-pulse" />
            ) : trace ? (
              <>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
                    {trace.task.type}
                  </span>
                  <span className={`text-[10px] font-mono uppercase tracking-widest ${
                    STATUS_COLORS[trace.task.status] ?? "text-zinc-500"
                  }`}>
                    {trace.task.status.replace(/_/g, " ")}
                  </span>
                </div>
                <h2 id="trace-panel-title" className="text-sm font-semibold text-zinc-100 leading-snug">
                  {trace.task.title}
                </h2>
                {trace.task.description && (
                  <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                    {trace.task.description}
                  </p>
                )}
              </>
            ) : (
              <span className="text-sm text-red-400">{error ?? "Not found"}</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={fetchTrace}
              className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors"
              title="Refresh"
            >
              ↻
            </button>
            <button
              onClick={onClose}
              className="text-zinc-600 hover:text-zinc-300 transition-colors text-lg leading-none"
              title="Close (Esc)"
              aria-label="Close panel"
            >
              ×
            </button>
          </div>
        </div>

        {/* Metrics bar */}
        {trace && !loading && (
          <div className="flex items-center gap-4 px-4 py-2 border-b border-white/5 shrink-0 text-xs font-mono text-zinc-600">
            <span>{trace.metrics.event_count} events</span>
            <span className="text-white/10">|</span>
            <span>{formatDuration(trace.metrics.duration_ms)}</span>
            <span className="text-white/10">|</span>
            <span>{formatCost(trace.metrics.total_cost_usd)}</span>
            {trace.metrics.total_tokens > 0 && (
              <>
                <span className="text-white/10">|</span>
                <span>{trace.metrics.total_tokens.toLocaleString()} tok</span>
              </>
            )}
            {trace.task.assigned_to && (
              <>
                <span className="text-white/10 ml-auto">|</span>
                <span className={`ml-auto ${AGENT_COLORS[trace.task.assigned_to] ?? "text-zinc-500"}`}>
                  {trace.task.assigned_to}
                </span>
              </>
            )}
          </div>
        )}

        {/* Column headers */}
        {trace && !loading && (
          <div className="flex items-center px-3 py-1 border-b border-white/5 text-[10px] text-zinc-700 shrink-0 font-mono"
               style={{ paddingLeft: 32 }}>
            <span className="flex-1">event</span>
            <div className="flex items-center gap-2">
              <span className="w-20">agent</span>
              <span className="w-10">cost</span>
              <span className="w-14 text-right">duration</span>
              <span className="w-16 text-right">time</span>
            </div>
          </div>
        )}

        {/* Event timeline */}
        <div className="flex-1 overflow-y-auto font-mono">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
              Loading trace…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-32 text-sm text-red-400">
              {error}
            </div>
          ) : trace && trace.events.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 gap-1 text-zinc-600">
              <span className="text-sm">No events recorded</span>
              <span className="text-xs">Task may be too new or events have not been emitted</span>
            </div>
          ) : trace ? (
            <>
              {trace.events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </>
          ) : null}
        </div>

        {/* Truncation notice */}
        {trace && !loading && trace.metrics.truncated && (
          <div className="px-4 py-1.5 border-t border-yellow-500/20 bg-yellow-500/5 text-[10px] text-yellow-600 font-mono shrink-0">
            Showing 100 of {trace.metrics.total_step_count} steps — oldest events shown first
          </div>
        )}

        {/* Footer */}
        {trace && !loading && (
          <div className="px-4 py-2 border-t border-white/5 flex items-center gap-4 text-[10px] text-zinc-700 shrink-0 font-mono">
            <span>{trace.metrics.step_count} steps</span>
            <span>{trace.metrics.transition_count} transitions</span>
            <span className="ml-auto text-zinc-800">{taskId.slice(0, 8)}</span>
          </div>
        )}
      </div>
    </>
  );
}
