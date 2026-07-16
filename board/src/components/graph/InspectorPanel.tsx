"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { Node } from "@xyflow/react";
import { getInspectorSections, type Renderer } from "./inspector-registry";
import { useInspectorData } from "./useInspectorData";
import {
  KeyValueRenderer,
  TimelineRenderer,
  TableRenderer,
  MeterRenderer,
  SparklineRenderer,
  WriteupRenderer,
} from "./renderers";

const rendererMap: Record<Renderer, React.ComponentType<{ data: unknown; fields?: string[]; columns?: string[] }>> = {
  "key-value": KeyValueRenderer,
  timeline: TimelineRenderer,
  table: TableRenderer,
  meter: MeterRenderer,
  sparkline: SparklineRenderer,
  writeup: WriteupRenderer,
};

interface Props {
  node: Node;
  onClose: () => void;
}

export default function InspectorPanel({ node, onClose }: Props) {
  const nodeType = node.type || "unknown";
  const nodeData = node.data as Record<string, unknown>;

  const nodeRef = useMemo(() => ({ id: node.id, type: nodeType, data: nodeData }), [node.id, nodeType, nodeData]);

  const sections = useMemo(
    () => getInspectorSections(nodeRef),
    [nodeRef],
  );

  const sectionStates = useInspectorData(sections, {
    id: node.id,
    type: nodeType,
    data: nodeData,
  });

  // Node display info
  const label = (nodeData.label as string) || node.id;
  const icon = (nodeData.icon as string) || "";
  const subtitle = (nodeData.role as string) || (nodeData.description as string) || nodeType;
  const tier = nodeData.tier as string | undefined;
  const model = nodeData.model as string | undefined;
  const activityStatus = nodeData.activityStatus as string | undefined;
  const initials = nodeData.initials as string | undefined;
  const color = nodeData.color as string | undefined;
  const textColor = nodeData.textColor as string | undefined;
  const lastTaskTitle = nodeData.lastTaskTitle as string | undefined;

  const statusDot = activityStatus === "processing" ? "bg-emerald-500 animate-pulse"
    : activityStatus === "claimed" ? "bg-amber-500"
    : "bg-zinc-600";

  return (
    <div className="h-full bg-surface border-l border-white/10 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {initials && color ? (
            <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center flex-shrink-0`}>
              <span className="text-[10px] font-bold text-white">{initials}</span>
            </div>
          ) : icon ? (
            <span className="text-base flex-shrink-0">{icon}</span>
          ) : null}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-zinc-200 truncate">{label}</div>
              {activityStatus && (
                <span className={`w-2 h-2 rounded-full ${statusDot} flex-shrink-0`} title={activityStatus} />
              )}
            </div>
            <div className="text-[10px] text-zinc-500">{subtitle}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
          aria-label="Close inspector"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M11 3L3 11M3 3l8 8" />
          </svg>
        </button>
      </div>

      {/* Node meta badges */}
      <div className="px-4 py-2 border-b border-white/5 flex-shrink-0 flex items-center gap-1.5 flex-wrap">
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent-bright font-medium uppercase tracking-wider">
          {nodeType}
        </span>
        {tier && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 font-medium">
            {tier}
          </span>
        )}
        {model && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400">
            {model}
          </span>
        )}
        {lastTaskTitle && (
          <div className="w-full mt-1 text-[9px] text-zinc-500 truncate" title={lastTaskTitle}>
            Working on: {lastTaskTitle}
          </div>
        )}
      </div>

      {/* Quick actions for agent/router nodes */}
      {(nodeType === "agent" || nodeType === "router") && (
        <div className="px-4 py-2 border-b border-white/5 flex-shrink-0 flex items-center gap-2">
          <Link
            href={`/activity?agent=${(nodeData.agentId as string) || node.id}`}
            className="text-[9px] px-2 py-1 rounded bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors"
          >
            View Activity
          </Link>
          <Link
            href={`/runs?agent=${(nodeData.agentId as string) || node.id}`}
            className="text-[9px] px-2 py-1 rounded bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors"
          >
            View Runs
          </Link>
          <Link
            href="/pipeline"
            className="text-[9px] px-2 py-1 rounded bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors"
          >
            Pipeline
          </Link>
        </div>
      )}

      {/* Sections */}
      <div className="flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <div className="p-4 text-[10px] text-zinc-600 italic text-center">
            No inspector data available for this node type.
          </div>
        ) : (
          sections.map((section) => {
            const state = sectionStates[section.id];
            const Component = rendererMap[section.renderer];

            return (
              <div key={section.id} className="px-4 py-3 border-b border-white/5">
                <div className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-2">
                  {section.title}
                  {section.refreshInterval && (
                    <span className="ml-1.5 text-[8px] text-zinc-600 normal-case tracking-normal">
                      (live)
                    </span>
                  )}
                </div>

                {state?.loading ? (
                  <div className="space-y-1.5">
                    <div className="h-3 bg-white/5 rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                    <div className="h-3 bg-white/5 rounded animate-pulse w-2/3" />
                  </div>
                ) : state?.error ? (
                  <div className="text-[10px] text-red-400/70 italic">{state.error}</div>
                ) : (
                  <Component
                    data={state?.data}
                    fields={section.fields}
                    columns={section.columns}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
