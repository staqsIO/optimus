"use client";

import { useState, useMemo } from "react";
import { usePipelineHealth } from "./usePipelineHealth";
import type { AgentQueue, StuckItem, BoardCommand, ThroughputBucket } from "./types";

import { getAgentDisplay } from "@/lib/agent-display";

function queueHealthColor(total: number): string {
  if (total === 0) return "bg-zinc-600";
  if (total <= 5) return "bg-emerald-400";
  if (total <= 10) return "bg-amber-400";
  return "bg-red-400";
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    created: "bg-zinc-500/20 text-zinc-400",
    assigned: "bg-blue-500/20 text-blue-400",
    in_progress: "bg-amber-500/20 text-amber-400",
    review: "bg-purple-500/20 text-purple-400",
    blocked: "bg-red-500/20 text-red-400",
    completed: "bg-emerald-500/20 text-emerald-400",
    failed: "bg-red-500/20 text-red-400",
    cancelled: "bg-zinc-500/20 text-zinc-500",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${colors[status] || "bg-zinc-500/20 text-zinc-400"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function timeAgo(dateStr: string): string {
  const mins = (Date.now() - new Date(dateStr).getTime()) / 60_000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function AgentAvatar({ agentId }: { agentId: string }) {
  const display = getAgentDisplay(agentId);
  return (
    <div
      className={`w-5 h-5 ${display.color} rounded-full flex items-center justify-center text-white font-semibold text-[8px] flex-shrink-0`}
      title={display.displayName}
    >
      {display.initials}
    </div>
  );
}

function Sparkline({ buckets, total }: { buckets: ThroughputBucket[]; total: number }) {
  // Fill 24 hours worth of buckets
  const now = new Date();
  const hours: number[] = Array(24).fill(0);
  for (const b of buckets) {
    const bDate = new Date(b.bucket);
    const hoursAgo = Math.floor((now.getTime() - bDate.getTime()) / 3_600_000);
    const idx = 23 - hoursAgo;
    if (idx >= 0 && idx < 24) hours[idx] = b.completed;
  }
  const max = Math.max(1, ...hours);

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-zinc-500 w-8 text-right">{total}</span>
      <div className="flex items-end gap-px h-5 flex-1">
        {hours.map((count, i) => (
          <div
            key={i}
            className="flex-1 bg-emerald-500/60 rounded-sm min-h-[1px] transition-all"
            style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
            title={`${24 - i}h ago: ${count} completed`}
          />
        ))}
      </div>
    </div>
  );
}

function QueueTable({ queues }: { queues: AgentQueue[] }) {
  if (queues.length === 0) {
    return <p className="text-[10px] text-zinc-600 py-1">No active work items</p>;
  }
  return (
    <div className="space-y-1">
      {queues.map(q => {
        const display = getAgentDisplay(q.agent_id);
        return (
          <div key={q.agent_id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-white/[0.02]">
            <AgentAvatar agentId={q.agent_id} />
            <span className={`text-xs font-medium w-16 truncate ${display.textColor}`}>{display.displayName}</span>
            <div className="flex-1 flex items-center gap-1.5 text-[9px]">
              {q.in_progress > 0 && <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-400">{q.in_progress} running</span>}
              {q.assigned > 0 && <span className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-400">{q.assigned} queued</span>}
              {q.in_review > 0 && <span className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-400">{q.in_review} review</span>}
              {q.blocked > 0 && <span className="px-1 py-0.5 rounded bg-red-500/15 text-red-400">{q.blocked} blocked</span>}
              {q.created > 0 && <span className="px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-400">{q.created} new</span>}
            </div>
            <span className="text-[10px] text-zinc-500 w-6 text-right">{q.total_active}</span>
          </div>
        );
      })}
    </div>
  );
}

function StuckList({ items, onAction }: { items: StuckItem[]; onAction?: (id: string, action: "cancel" | "retry") => Promise<void> }) {
  const [actionInFlight, setActionInFlight] = useState<Record<string, string>>({});

  const handleAction = async (id: string, action: "cancel" | "retry") => {
    if (!onAction || actionInFlight[id]) return;
    setActionInFlight(prev => ({ ...prev, [id]: action }));
    try {
      await onAction(id, action);
    } catch (err) {
      console.error(`[stuck] ${action} failed for ${id}:`, err);
    } finally {
      setActionInFlight(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  if (items.length === 0) return null;

  const retryableStates = ["in_progress", "timed_out", "failed", "blocked"];
  const cancellableStates = ["in_progress", "assigned", "timed_out", "blocked", "review"];

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-red-400 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
        {items.length} stuck item{items.length !== 1 ? "s" : ""}
      </div>
      {items.map(item => {
        const inFlight = actionInFlight[item.id];
        return (
          <div key={item.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-white/[0.02]">
            <AgentAvatar agentId={item.assigned_to} />
            <span className="text-[10px] text-zinc-300 flex-1 truncate" title={item.title}>
              {item.title}
            </span>
            {statusBadge(item.status)}
            {item.campaign_iterations && (
              <span className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[9px]">
                {item.campaign_iterations} iter
              </span>
            )}
            {item.retry_count >= 2 && (
              <span className="px-1 py-0.5 rounded bg-red-500/15 text-red-400 text-[9px]">
                retry {item.retry_count}
              </span>
            )}
            <span className="text-[9px] text-zinc-600">
              {Math.round(item.minutes_since_update)}m stale
            </span>
            {onAction && (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {retryableStates.includes(item.status) && (
                  <button
                    onClick={() => handleAction(item.id, "retry")}
                    disabled={!!inFlight}
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 disabled:opacity-40 transition-colors"
                    title="Retry — reset to assigned with fresh retry count"
                  >
                    {inFlight === "retry" ? "..." : "\u21BB"}
                  </button>
                )}
                {cancellableStates.includes(item.status) && (
                  <button
                    onClick={() => handleAction(item.id, "cancel")}
                    disabled={!!inFlight}
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-40 transition-colors"
                    title="Cancel — move to terminal cancelled state"
                  >
                    {inFlight === "cancel" ? "..." : "\u2715"}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BoardCommandList({ commands }: { commands: BoardCommand[] }) {
  if (commands.length === 0) {
    return <p className="text-[10px] text-zinc-600 py-1">No board commands yet</p>;
  }
  return (
    <div className="space-y-1">
      {commands.map(cmd => (
        <div key={cmd.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-white/[0.02]">
          <AgentAvatar agentId={cmd.assigned_to || "orchestrator"} />
          <span className="text-[10px] text-zinc-300 flex-1 truncate" title={cmd.title}>
            {cmd.title}
          </span>
          {statusBadge(cmd.status)}
          <span className="text-[9px] text-zinc-600">{timeAgo(cmd.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

export default function PipelineHealthPanel() {
  const { health, throughput, loading, error, stuckAction } = usePipelineHealth();
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<"queues" | "stuck" | "commands">("queues");

  const totalActive = useMemo(() => {
    if (!health?.queues) return 0;
    return health.queues.reduce((sum, q) => sum + q.total_active, 0);
  }, [health]);

  const stuckCount = health?.stuck?.length || 0;

  if (loading && !health) {
    return (
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-600 animate-pulse" />
          <span>Loading pipeline health...</span>
        </div>
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-600" />
          <span>Pipeline health unavailable</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg">
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center justify-between p-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span className="font-medium">Pipeline Health</span>
          <span className="px-1.5 py-0.5 text-[9px] bg-white/5 text-zinc-500 rounded-full">
            {totalActive} active
          </span>
          {stuckCount > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] bg-red-500/15 text-red-400 rounded-full animate-pulse">
              {stuckCount} stuck
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Mini throughput + queue dots */}
          {throughput && (
            <span className="text-[9px] text-zinc-600">{throughput.total_24h} / 24h</span>
          )}
          <div className="flex items-center gap-0.5">
            {health?.queues.map(q => (
              <div
                key={q.agent_id}
                className={`w-2 h-2 rounded-full ${queueHealthColor(q.total_active)}`}
                title={`${getAgentDisplay(q.agent_id).displayName}: ${q.total_active} active`}
              />
            ))}
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Throughput sparkline */}
          {throughput && (
            <div>
              <div className="text-[10px] text-zinc-500 mb-1">Throughput (24h)</div>
              <Sparkline buckets={throughput.buckets} total={throughput.total_24h} />
            </div>
          )}

          {/* Section tabs */}
          <div className="flex items-center gap-1 border-b border-white/5 pb-1">
            {([
              ["queues", "Queues"] as const,
              ["stuck", `Stuck${stuckCount > 0 ? ` (${stuckCount})` : ""}`] as const,
              ["commands", "Board Commands"] as const,
            ]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSection(key)}
                className={`px-2 py-1 text-[10px] rounded transition-colors ${
                  section === key
                    ? "bg-white/5 text-zinc-200 font-medium"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Section content */}
          {section === "queues" && health && <QueueTable queues={health.queues} />}
          {section === "stuck" && health && (
            health.stuck.length > 0
              ? <StuckList items={health.stuck} onAction={stuckAction} />
              : <p className="text-[10px] text-zinc-600 py-1">No stuck items — pipeline is healthy</p>
          )}
          {section === "commands" && health && <BoardCommandList commands={health.boardCommands} />}
        </div>
      )}
    </div>
  );
}
