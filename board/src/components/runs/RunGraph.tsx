"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import Dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import "@/components/graph/graph-styles.css";
import "./run-graph-styles.css";

import WorkItemNode from "./WorkItemNode";
import RunInspectorPanel from "./RunInspectorPanel";
import { opsFetch } from "@/lib/ops-api";
import { getAgentDisplay, formatAgentId } from "@/lib/agent-display";
import type { RunTreeResponse, RunTreeItem, RunCost } from "./types";

const nodeTypes = { "work-item": WorkItemNode };

const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;

interface Props {
  runId: string;
}

/* ── Dagre layout ──────────────────────────────────────── */

function layoutGraph(
  items: RunTreeItem[],
  treeEdges: RunEdgeInternal[],
  costs: Map<string, RunCost>
): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 100, edgesep: 40 });

  for (const item of items) {
    g.setNode(item.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Collect explicit edge pairs to deduplicate parent_id edges
  const explicitPairs = new Set<string>();
  for (const e of treeEdges) {
    explicitPairs.add(`${e.from_id}:${e.to_id}`);
    g.setEdge(e.from_id, e.to_id);
  }

  // parent_id edges (only if no explicit edge exists)
  for (const item of items) {
    if (item.parent_id && !explicitPairs.has(`${item.parent_id}:${item.id}`)) {
      g.setEdge(item.parent_id, item.id);
    }
  }

  Dagre.layout(g);

  const nodes: Node[] = items.map((item) => {
    const pos = g.node(item.id);
    const cost = costs.get(item.id);
    return {
      id: item.id,
      type: "work-item",
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: {
        workItemId: item.id,
        title: item.title,
        type: item.type,
        status: item.status,
        agentId: item.assigned_to,
        costUsd: cost ? parseFloat(cost.cost_usd) : 0,
        durationMs: item.duration_ms,
        tokenCount: cost ? parseInt(cost.total_tokens) : 0,
        triggerSource: item.parent_id === null
          ? (item.metadata?.webhook_source as string) ||
            (item.metadata?.source as string) ||
            item.created_by
          : undefined,
      },
    };
  });

  const edges: Edge[] = [];

  // Explicit edges (from edges table)
  for (const e of treeEdges) {
    edges.push({
      id: `edge-${e.id}`,
      source: e.from_id,
      target: e.to_id,
      ...edgeStyle(e.edge_type),
    });
  }

  // Parent-child edges (implicit, only if no explicit)
  for (const item of items) {
    if (item.parent_id && !explicitPairs.has(`${item.parent_id}:${item.id}`)) {
      edges.push({
        id: `parent-${item.parent_id}-${item.id}`,
        source: item.parent_id,
        target: item.id,
        style: { stroke: "rgba(255,255,255,0.08)", strokeWidth: 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(255,255,255,0.08)", width: 12, height: 12 },
      });
    }
  }

  return { nodes, edges };
}

interface RunEdgeInternal {
  id: string;
  from_id: string;
  to_id: string;
  edge_type: string;
}

function edgeStyle(type: string): Partial<Edge> {
  switch (type) {
    case "decomposes_into":
      return {
        style: { stroke: "#a1a1aa", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#a1a1aa", width: 14, height: 14 },
      };
    case "blocks":
      return {
        style: { stroke: "#f87171", strokeWidth: 1.5, strokeDasharray: "6 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#f87171", width: 14, height: 14 },
      };
    case "depends_on":
      return {
        style: { stroke: "#fbbf24", strokeWidth: 1.5, strokeDasharray: "3 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#fbbf24", width: 14, height: 14 },
      };
    default:
      return {
        style: { stroke: "rgba(255,255,255,0.1)", strokeWidth: 1 },
      };
  }
}

/* ── Trigger source icons ─────────────────────────────── */

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

/* ── Status summary ───────────────────────────────────── */

const STATUS_DOT: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  in_progress: "bg-amber-500",
  cancelled: "bg-zinc-500",
};

/* ── Component ────────────────────────────────────────── */

export default function RunGraph({ runId }: Props) {
  const [treeData, setTreeData] = useState<RunTreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<RunTreeItem | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Fetch tree data
  const fetchTree = useCallback(async () => {
    const data = await opsFetch<RunTreeResponse>(`/api/runs/tree?id=${runId}`);
    if (!data || "error" in data) {
      setError((data as { error?: string })?.error || "Failed to load run");
      return;
    }
    setTreeData(data);
  }, [runId]);

  useEffect(() => {
    fetchTree();
    const interval = setInterval(fetchTree, 10_000);
    return () => clearInterval(interval);
  }, [fetchTree]);

  // Layout when data changes
  useEffect(() => {
    if (!treeData) return;

    const costsMap = new Map(treeData.costs.map((c) => [c.task_id, c]));
    const { nodes: layoutNodes, edges: layoutEdges } = layoutGraph(
      treeData.items,
      treeData.edges,
      costsMap
    );

    // Mark selected node
    if (selectedItem) {
      const sel = layoutNodes.find((n) => n.id === selectedItem.id);
      if (sel) (sel.data as Record<string, unknown>).selected = true;
    }

    setNodes(layoutNodes);
    setEdges(layoutEdges);
  }, [treeData, selectedItem, setNodes, setEdges]);

  // Click handler
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!treeData) return;
      const item = treeData.items.find((i) => i.id === node.id);
      if (!item) return;
      setSelectedItem((prev) => (prev?.id === item.id ? null : item));
    },
    [treeData]
  );

  // Summary stats
  const summary = useMemo(() => {
    if (!treeData) return null;
    const root = treeData.root;
    const totalCost = treeData.costs.reduce((sum, c) => sum + parseFloat(c.cost_usd), 0);
    const agents = new Set(treeData.items.map((i) => i.assigned_to).filter(Boolean));
    const triggerSource =
      (root.metadata?.webhook_source as string) ||
      (root.metadata?.source as string) ||
      root.created_by;
    return {
      title: root.title,
      status: root.status,
      triggerSource,
      itemCount: treeData.items.length,
      agentCount: agents.size,
      totalCost,
      durationMs: root.duration_ms,
      createdAt: root.created_at,
    };
  }, [treeData]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-49px)] text-zinc-500 text-sm">
        {error}
      </div>
    );
  }

  if (!treeData || !summary) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-49px)] text-zinc-500 text-sm">
        Loading run...
      </div>
    );
  }

  const inspectorOpen = selectedItem !== null;

  return (
    <div className="h-[calc(100vh-49px)] flex flex-col bg-[#0a0a0f]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 bg-surface-raised">
        <div className="flex items-center gap-3 min-w-0">
          <a
            href="/runs"
            className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
          >
            \u2190 Runs
          </a>
          <span className="text-white/10">|</span>
          <span className="text-lg mr-1">{getTriggerIcon(summary.triggerSource)}</span>
          <span className="text-sm text-zinc-200 font-medium truncate">{summary.title}</span>
          <span
            className={`w-2 h-2 rounded-full ${STATUS_DOT[summary.status] || "bg-zinc-500"}`}
          />
          <span className="text-[10px] text-zinc-500">{summary.status}</span>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-zinc-500 tabular-nums flex-shrink-0">
          <span>{summary.itemCount} items</span>
          <span>{summary.agentCount} agents</span>
          <span>${summary.totalCost.toFixed(4)}</span>
          <span>
            {summary.durationMs > 60_000
              ? `${Math.round(summary.durationMs / 60_000)}m`
              : `${(summary.durationMs / 1000).toFixed(1)}s`}
          </span>
          <span className="text-zinc-600">
            {new Date(summary.createdAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
      </div>

      {/* Graph + Inspector */}
      <div className="flex-1 flex">
        <div className={inspectorOpen ? "w-[65%]" : "w-full"} style={{ height: "100%" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.03)" />
            <Controls />
            <MiniMap
              nodeColor={(node) => {
                const d = node.data as Record<string, unknown>;
                const status = d.status as string;
                if (status === "completed") return "#10b981";
                if (status === "failed") return "#ef4444";
                if (status === "in_progress") return "#f59e0b";
                return "#3f3f46";
              }}
              maskColor="rgba(99, 102, 241, 0.15)"
            />
            {/* Legend */}
            <Panel position="bottom-left">
              <div className="bg-surface-raised/90 backdrop-blur border border-white/5 rounded-lg px-3 py-2 text-[9px] text-zinc-500 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="w-4 border-t border-zinc-400" /> decomposes_into
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-4 border-t border-dashed border-red-400" /> blocks
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-4 border-t border-dotted border-amber-400" /> depends_on
                </div>
              </div>
            </Panel>
          </ReactFlow>
        </div>

        {inspectorOpen && selectedItem && (
          <div className="w-[35%]" style={{ height: "100%" }}>
            <RunInspectorPanel
              item={selectedItem}
              runId={runId}
              onClose={() => setSelectedItem(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
