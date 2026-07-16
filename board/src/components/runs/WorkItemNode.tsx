"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getAgentDisplay } from "@/lib/agent-display";

export interface WorkItemNodeData {
  workItemId: string;
  title: string;
  type: "directive" | "workstream" | "task" | "subtask";
  status: string;
  agentId: string | null;
  costUsd: number;
  durationMs: number;
  tokenCount: number;
  triggerSource?: string;
  selected?: boolean;
  [key: string]: unknown;
}

const TYPE_LABELS: Record<string, string> = {
  directive: "DIR",
  workstream: "WS",
  task: "TSK",
  subtask: "SUB",
};

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function WorkItemNode({ data }: NodeProps) {
  const d = data as unknown as WorkItemNodeData;
  const agent = d.agentId ? getAgentDisplay(d.agentId) : null;
  const statusClass = `run-node-status-${d.status}`;

  return (
    <div
      className={`run-work-item-node ${statusClass} ${d.selected ? "selected" : ""}`}
      style={{ width: 240 }}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !w-2 !h-2 !border-0" />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        {agent ? (
          <div
            className={`w-6 h-6 rounded-full ${agent.color} flex items-center justify-center flex-shrink-0`}
          >
            <span className="text-[9px] font-bold text-white">{agent.initials}</span>
          </div>
        ) : (
          <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center flex-shrink-0">
            <span className="text-[9px] text-zinc-400">--</span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-zinc-200 font-medium truncate leading-tight">
            {d.title}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-zinc-500 font-medium">
              {TYPE_LABELS[d.type] || d.type}
            </span>
            {agent && (
              <span className={`text-[9px] ${agent.textColor} truncate`}>
                {d.agentId}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Status + Stats bar */}
      <div className="flex items-center justify-between px-3 pb-2 pt-1 border-t border-white/5 mt-1">
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[d.status] || "bg-zinc-500"}`} />
          <span className="text-[9px] text-zinc-500">{d.status.replace("_", " ")}</span>
        </div>
        <div className="flex items-center gap-2 text-[9px] text-zinc-600 tabular-nums">
          {d.costUsd > 0 && <span>{formatCost(d.costUsd)}</span>}
          {d.durationMs > 0 && <span>{formatDuration(d.durationMs)}</span>}
          {d.tokenCount > 0 && <span>{d.tokenCount.toLocaleString()}t</span>}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
    </div>
  );
}

export default memo(WorkItemNode);
