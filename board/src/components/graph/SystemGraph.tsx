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
  type NodeMouseHandler,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import InspectorPanel from "./InspectorPanel";
import "@xyflow/react/dist/style.css";
import "./graph-styles.css";
import {
  nodeTypes,
  type AgentNodeData,
  type SourceNodeData,
  type TierNodeData,
  type DestinationNodeData,
  type SystemNodeData,
  type ServiceNodeData,
  type StoreNodeData,
  type GovernanceNodeData,
  type IntegrationNodeData,
  type RouterNodeData,
} from "./nodes";

import { getAgentDisplay, formatModelLabel, formatAgentId } from "@/lib/agent-display";

/* ── View types ───────────────────────────────────────── */

type ViewMode = "unified" | "agents" | "signals" | "architecture";

interface ConfigGateTrigger {
  type: string;
  value: string;
}

interface ConfigGatesData {
  linear?: {
    triggers: ConfigGateTrigger[];
    watchedTeams: string[];
    watchedProjects: string[];
    intentLabels: Record<string, { agent: string; tier: string }>;
    repoMapping: Record<string, string>;
  } | null;
  github?: {
    repos: string[];
    autoFixLabels: string[];
    intentLabels: Record<string, { agent: string; tier: string }>;
    watchedEvents: string[];
    defaultAgent: string | null;
  } | null;
}

interface GraphData {
  topology?: {
    nodes: Array<{ id: string; tier: string; model: string; recentTasks: number; recentSuccesses: number; capabilities: string[]; enabled?: boolean }>;
    edges: Array<{ source: string; target: string; successRate: number | null }>;
    source: string;
  };
  signals?: {
    linear_signals_today?: number;
    github_signals_today?: number;
    transcript_signals_today?: number;
    signal_only_today?: number;
    intents_pending?: number;
    work_items_active?: number;
  };
  spec?: {
    status?: Array<{ section: string; title: string; status: string; references: number }>;
  };
  configGates?: ConfigGatesData;
}

/* ── Agent activity types ────────────────────────────── */

interface AgentHeartbeat {
  status: string;
  taskTitle?: string;
  online?: boolean;
  lastSeen?: string;
}

type AgentActivityMap = Record<string, AgentHeartbeat>;

function resolveActivityStatus(heartbeat?: AgentHeartbeat): 'idle' | 'processing' | 'claimed' {
  if (!heartbeat) return 'idle';
  if (heartbeat.status === 'processing' || heartbeat.status === 'in_progress') return 'processing';
  if (heartbeat.status === 'claimed' || heartbeat.status === 'assigned') return 'claimed';
  return 'idle';
}

/* ── Layout constants ─────────────────────────────────── */

const COL_WIDTH = 200;
const ROW_HEIGHT = 120;

/** Agents that run on the M1 MacBook runner, not Railway */
const RUNNER_AGENTS = new Set([
  "executor-coder", "executor-redesign", "executor-blueprint",
  "executor-research", "claw-campaigner", "claw-workshop",
]);

/** Functional sort order for agents */
const AGENT_ORDER = [
  "orchestrator",
  "executor-intake", "executor-triage", "executor-responder", "reviewer", "strategist", "architect", "executor-ticket",
  "executor-coder", "executor-redesign", "executor-blueprint", "executor-research",
  "claw-campaigner", "claw-workshop",
];

/* ── Build Unified (overview) graph ───────────────────── */

function buildUnifiedGraph(data: GraphData, activity: AgentActivityMap = {}): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const signals = data.signals || {};
  const topoNodes = data.topology?.nodes || [];
  const topoEdges = data.topology?.edges || [];

  // ── Row 0: Source channels ───────────────────────────
  const sources = [
    { id: "src-email", label: "Email", channel: "Gmail", icon: "\u2709\uFE0F", color: "bg-blue-500/10 text-blue-400", stroke: "#3b82f6", signals: 0 },
    { id: "src-linear", label: "Linear", channel: "Webhooks", icon: "\uD83D\uDCCB", color: "bg-violet-500/10 text-violet-400", stroke: "#8b5cf6", signals: signals.linear_signals_today || 0 },
    { id: "src-github", label: "GitHub", channel: "Webhooks", icon: "\uD83D\uDC19", color: "bg-zinc-300/10 text-zinc-300", stroke: "#a1a1aa", signals: signals.github_signals_today || 0 },
    { id: "src-slack", label: "Slack", channel: "Socket Mode", icon: "\uD83D\uDCAC", color: "bg-green-500/10 text-green-400", stroke: "#22c55e", signals: 0 },
    { id: "src-tldv", label: "tl;dv", channel: "Drive Watcher", icon: "\uD83C\uDFA5", color: "bg-orange-500/10 text-orange-400", stroke: "#f97316", signals: signals.transcript_signals_today || 0 },
  ];

  sources.forEach((src, i) => {
    nodes.push({
      id: src.id,
      type: "source",
      position: { x: i * COL_WIDTH, y: 0 },
      data: { label: src.label, channel: src.channel, icon: src.icon, signalsToday: src.signals, color: src.color } as SourceNodeData,
    });
  });

  // ── Sort agents functionally ─────────────────────────
  const sortedAgents = [...topoNodes].sort((a, b) => {
    const ia = AGENT_ORDER.indexOf(a.id);
    const ib = AGENT_ORDER.indexOf(b.id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const orchestrator = sortedAgents.find(a => a.id === "orchestrator");
  const otherAgents = sortedAgents.filter(a => a.id !== "orchestrator");

  // ── Row 1: Orchestrator hub ────────────────────────
  const orchY = ROW_HEIGHT * 1.5;
  if (orchestrator) {
    const display = getAgentDisplay(orchestrator.id);
    const pct = orchestrator.recentTasks > 0 ? Math.round((orchestrator.recentSuccesses / orchestrator.recentTasks) * 100) : null;

    const orchHeartbeat = activity[orchestrator.id];
    nodes.push({
      id: `agent-${orchestrator.id}`,
      type: "agent",
      position: { x: COL_WIDTH * 2, y: orchY },
      data: {
        label: display.displayName, agentId: orchestrator.id, tier: orchestrator.tier,
        model: formatModelLabel(orchestrator.model), initials: display.initials,
        color: display.color, textColor: display.textColor, role: formatAgentId(orchestrator.id),
        recentTasks: orchestrator.recentTasks, successRate: pct,
        capabilities: orchestrator.capabilities || [],
        activityStatus: resolveActivityStatus(orchHeartbeat),
        lastTaskTitle: orchHeartbeat?.taskTitle,
      } as AgentNodeData,
    });

    // Source \u2192 Orchestrator edges (animate when orchestrator is processing)
    const orchProcessing = resolveActivityStatus(orchHeartbeat) === 'processing';
    for (const src of sources) {
      edges.push({
        id: `e-${src.id}-orch`, source: src.id, target: `agent-${orchestrator.id}`,
        animated: orchProcessing,
        style: { stroke: src.stroke, strokeWidth: 1.5, opacity: 0.4 },
        markerEnd: { type: MarkerType.ArrowClosed, color: src.stroke, width: 12, height: 12 },
      });
    }
  }

  // ── Row 2-3: Other agents (functional order) ──────
  const agentY = ROW_HEIGHT * 3;
  const COLS = 6;

  otherAgents.forEach((agent, i) => {
    const display = getAgentDisplay(agent.id);
    const pct = agent.recentTasks > 0 ? Math.round((agent.recentSuccesses / agent.recentTasks) * 100) : null;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const heartbeat = activity[agent.id];

    nodes.push({
      id: `agent-${agent.id}`,
      type: "agent",
      position: { x: col * COL_WIDTH, y: agentY + row * ROW_HEIGHT * 1.2 },
      data: {
        label: display.displayName, agentId: agent.id, tier: agent.tier,
        model: formatModelLabel(agent.model), initials: display.initials,
        color: display.color, textColor: display.textColor, role: formatAgentId(agent.id),
        recentTasks: agent.recentTasks || 0, successRate: pct,
        capabilities: agent.capabilities || [],
        deployment: RUNNER_AGENTS.has(agent.id) ? "runner" : "cloud",
        activityStatus: resolveActivityStatus(heartbeat),
        lastTaskTitle: heartbeat?.taskTitle,
      } as AgentNodeData,
    });
  });

  // Agent delegation edges from topology (animate edges to/from processing agents)
  const processingAgentIds = new Set(
    topoNodes.filter(n => resolveActivityStatus(activity[n.id]) === 'processing').map(n => n.id)
  );

  for (const te of topoEdges) {
    const color = te.successRate === null ? "#3f3f46"
      : te.successRate >= 0.8 ? "#10b981"
      : te.successRate >= 0.5 ? "#f59e0b"
      : "#ef4444";

    const edgeActive = processingAgentIds.has(te.source) || processingAgentIds.has(te.target);

    edges.push({
      id: `e-agent-${te.source}-${te.target}`,
      source: `agent-${te.source}`,
      target: `agent-${te.target}`,
      animated: edgeActive,
      style: { stroke: color, strokeWidth: 1.5, opacity: 0.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
      label: te.successRate !== null ? `${Math.round(te.successRate * 100)}%` : undefined,
      labelStyle: { fill: "#71717a", fontSize: 9 },
      labelBgStyle: { fill: "#12121a", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    });
  }

  // ── Row 4: Destinations ──────────────────────────────
  const destY = agentY + ROW_HEIGHT * 3.5;

  nodes.push({
    id: "dest-briefing", type: "destination",
    position: { x: COL_WIDTH * 0.5, y: destY },
    data: { label: "Daily Briefing", icon: "\uD83D\uDCE8", description: "Email + Slack digest" } as DestinationNodeData,
  });
  nodes.push({
    id: "dest-dashboard", type: "destination",
    position: { x: COL_WIDTH * 2.5, y: destY },
    data: { label: "Board Dashboard", icon: "\uD83D\uDCCA", description: "Workstation UI" } as DestinationNodeData,
  });

  // Key agent \u2192 destination edges
  if (topoNodes.some(n => n.id === "architect")) {
    edges.push({
      id: "e-arch-brief", source: "agent-architect", target: "dest-briefing",
      animated: false, style: { stroke: "#818cf8", strokeWidth: 1.5, opacity: 0.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 10, height: 10 },
    });
  }
  if (orchestrator) {
    edges.push({
      id: "e-orch-dash", source: `agent-${orchestrator.id}`, target: "dest-dashboard",
      animated: false, style: { stroke: "#818cf8", strokeWidth: 1, strokeDasharray: "3 3", opacity: 0.3 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 10, height: 10 },
    });
  }

  return { nodes, edges };
}

/* ── Architecture View Layout ─────────────────────────── */

const ARCH_COL = 260;
const ARCH_ROW = 200;
const RIGHT_COL_X = ARCH_COL * 7; // Enforcement & intelligence swim lane

function buildArchitectureGraph(data: GraphData, activity: AgentActivityMap = {}): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const signals = data.signals || {};
  const topoNodes = data.topology?.nodes || [];
  const topoEdges = data.topology?.edges || [];
  const configGates = data.configGates;

  const edge = (id: string, source: string, target: string, color: string, opts?: { dashed?: boolean; animated?: boolean; opacity?: number; label?: string }) => {
    edges.push({
      id,
      source,
      target,
      animated: opts?.animated ?? false,
      label: opts?.label,
      labelStyle: opts?.label ? { fill: "#71717a", fontSize: 9 } : undefined,
      labelBgStyle: opts?.label ? { fill: "#12121a", fillOpacity: 0.9 } : undefined,
      labelBgPadding: opts?.label ? [4, 2] as [number, number] : undefined,
      style: { stroke: color, strokeWidth: 1.5, opacity: opts?.opacity ?? 0.4, ...(opts?.dashed ? { strokeDasharray: "5 5" } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
    });
  };

  // =======================================================
  // LANE 0: GOVERNANCE
  // =======================================================
  const govY = 0;

  nodes.push({
    id: "gov-principles", type: "governance", position: { x: 0, y: govY },
    data: { label: "Design Principles", description: "P1-P6 (non-negotiable)", icon: "\u{1F6E1}\uFE0F", subtitle: "P1 Deny-by-default \u2022 P2 Infra enforces \u2022 P4 Boring infra" } as GovernanceNodeData,
  });
  nodes.push({
    id: "gov-board", type: "governance", position: { x: ARCH_COL * 2.5, y: govY },
    data: { label: "Board of Directors", description: "Dustin & Eric", icon: "\u{1F3DB}\uFE0F", subtitle: "Human governance \u2014 strategy, ethics, budgets" } as GovernanceNodeData,
  });
  nodes.push({
    id: "gov-spec", type: "governance", position: { x: ARCH_COL * 5, y: govY },
    data: { label: "SPEC.md v0.7.0", description: "Canonical architecture", icon: "\u{1F4DC}", subtitle: "Both board members must approve changes" } as GovernanceNodeData,
  });

  edge("e-gov-board-spec", "gov-board", "gov-spec", "#fbbf24", { dashed: true, opacity: 0.3 });
  edge("e-gov-board-principles", "gov-board", "gov-principles", "#fbbf24", { dashed: true, opacity: 0.3 });

  // =======================================================
  // LANE 1: INGRESS (Sources)
  // =======================================================
  const srcY = ARCH_ROW * 1.4;

  const integrations = [
    { id: "int-gmail", label: "Gmail", auth: "OAuth polling (60s)", icon: "\u2709\uFE0F", color: "bg-blue-500/10 text-blue-400", signals: 0 },
    { id: "int-slack", label: "Slack", auth: "Socket Mode", icon: "\u{1F4AC}", color: "bg-green-500/10 text-green-400", signals: 0 },
    { id: "int-linear", label: "Linear", auth: "Webhooks (HMAC)", icon: "\u{1F4CB}", color: "bg-violet-500/10 text-violet-400", signals: signals.linear_signals_today || 0 },
    { id: "int-github", label: "GitHub", auth: "App + Webhooks", icon: "\u{1F419}", color: "bg-zinc-300/10 text-zinc-300", signals: signals.github_signals_today || 0 },
    { id: "int-drive", label: "Google Drive / tl;dv", auth: "Folder watcher", icon: "\u{1F3A5}", color: "bg-orange-500/10 text-orange-400", signals: signals.transcript_signals_today || 0 },
    { id: "int-telegram", label: "Telegram", auth: "Bot API", icon: "\u{1F4E8}", color: "bg-sky-500/10 text-sky-400", signals: 0 },
  ];

  integrations.forEach((src, i) => {
    nodes.push({
      id: src.id, type: "integration", position: { x: i * (ARCH_COL * 0.95), y: srcY },
      data: { label: src.label, authMethod: src.auth, icon: src.icon, color: src.color, signalsToday: src.signals } as IntegrationNodeData,
    });
  });

  // =======================================================
  // LANE 2: ROUTING (Adapter -> Config Gates -> Orchestrator)
  // =======================================================
  const routeY = ARCH_ROW * 2.7;

  // Adapter Layer
  nodes.push({
    id: "sys-adapter", type: "system", position: { x: ARCH_COL * 0, y: routeY },
    data: { label: "Adapter Layer", description: "8 adapters (ADR-008)", icon: "\u{1F50C}", color: "bg-indigo-500/10 text-indigo-400", badges: ["Email", "Slack", "Webhook", "Telegram", "Drive"] } as SystemNodeData,
  });

  // Config Gates
  const configBadges: string[] = [];
  if (configGates?.linear) {
    for (const t of configGates.linear.triggers) {
      configBadges.push(t.type === "assignee" ? `${t.value} assignment` : `"${t.value}" label`);
    }
  }
  if (configGates?.github) {
    for (const l of configGates.github.autoFixLabels) {
      configBadges.push(`"${l}" label`);
    }
  }
  if (configBadges.length === 0) configBadges.push("linear-bot.json", "github-bot.json");

  nodes.push({
    id: "sys-config", type: "system", position: { x: ARCH_COL * 2, y: routeY },
    data: {
      label: "Config Gates", description: "Deny-by-default scope filters (P1)",
      icon: "\u{2699}\uFE0F", color: "bg-zinc-500/10 text-zinc-400",
      badges: configBadges, configGates,
    } as SystemNodeData,
  });

  // Task Graph (coordination hub between routing and agents)
  nodes.push({
    id: "sys-taskgraph", type: "system", position: { x: ARCH_COL * 2, y: ARCH_ROW * 4 },
    data: { label: "Task Graph", description: "Postgres DAG \u2014 atomic state transitions", icon: "\u{1F578}\uFE0F", color: "bg-emerald-500/10 text-emerald-400", badges: ["created \u2192 assigned \u2192 in_progress \u2192 completed"] } as SystemNodeData,
  });

  // Orchestrator as RouterNode
  const orchestratorAgent = topoNodes.find(n => n.id === "orchestrator");
  const orchPct = orchestratorAgent && orchestratorAgent.recentTasks > 0
    ? Math.round((orchestratorAgent.recentSuccesses / orchestratorAgent.recentTasks) * 100) : null;

  nodes.push({
    id: "router-orchestrator", type: "router",
    position: { x: ARCH_COL * 4.2, y: routeY - 30 },
    data: {
      label: "Orchestrator",
      description: "Receptionist pattern",
      icon: "\u{1F500}",
      agentId: "orchestrator",
      model: orchestratorAgent ? formatModelLabel(orchestratorAgent.model) : "Unknown",
      recentTasks: orchestratorAgent?.recentTasks || 0,
      successRate: orchPct,
      rules: [
        { label: "FYI \u2192 log only", target: "", color: "bg-zinc-500", terminal: true },
        { label: "Noise \u2192 archive", target: "", color: "bg-zinc-600", terminal: true },
        { label: "Feedback pipeline", target: "ticket", color: "bg-orange-500" },
        { label: "Complex analysis", target: "strategist", color: "bg-purple-500" },
        { label: "Simple response", target: "responder", color: "bg-amber-500" },
        { label: "Action required", target: "strategist", color: "bg-purple-500" },
      ],
      fallback: "any agent",
    } as RouterNodeData,
  });

  // Event Bus
  nodes.push({
    id: "sys-eventbus", type: "system", position: { x: RIGHT_COL_X, y: ARCH_ROW * 3.2 },
    data: { label: "Event Bus", description: "pg_notify \u2014 no external queue (P4)", icon: "\u{1F4E1}", color: "bg-yellow-500/10 text-yellow-400" } as SystemNodeData,
  });

  // Sources \u2192 Adapter
  for (const src of integrations) {
    edge(`e-${src.id}-adapter`, src.id, "sys-adapter", "#6366f1", { opacity: 0.25 });
  }

  // Triage path: Adapter \u2192 Config Gates \u2192 Orchestrator
  edge("e-adapter-config", "sys-adapter", "sys-config", "#6366f1");
  edge("e-config-orchestrator", "sys-config", "router-orchestrator", "#10b981", { animated: true, label: "triage path" });

  // Orchestrator <-> Task Graph
  edge("e-orch-taskgraph", "router-orchestrator", "sys-taskgraph", "#10b981", { animated: true, label: "claim & assign" });
  edge("e-taskgraph-eventbus", "sys-taskgraph", "sys-eventbus", "#eab308", { opacity: 0.3, label: "pg_notify" });

  // =======================================================
  // LANE 3: AGENT FLEET (collapsed subsystem view)
  // Architecture view shows the *structure* — individual agents and their
  // delegation edges live on the Agents tab. Keeps this diagram legible
  // at ~20 nodes instead of ~35+.
  // =======================================================
  const fleetY = ARCH_ROW * 5.5;
  const totalAgents = topoNodes.filter(n => n.id !== "orchestrator").length;
  const cloudCount = topoNodes.filter(n => n.id !== "orchestrator" && !RUNNER_AGENTS.has(n.id)).length;
  const runnerCount = topoNodes.filter(n => RUNNER_AGENTS.has(n.id)).length;
  const processingCount = topoNodes.filter(n => resolveActivityStatus(activity[n.id]) === 'processing').length;

  nodes.push({
    id: "sys-fleet", type: "system",
    position: { x: ARCH_COL * 2, y: fleetY },
    data: {
      label: "Agent Fleet",
      description: `${totalAgents} agents \u2014 see Agents tab for fleet detail`,
      icon: "\u{1F465}",
      color: "bg-teal-500/10 text-teal-400",
      badges: [
        `${cloudCount} cloud`,
        `${runnerCount} runner`,
        ...(processingCount > 0 ? [`${processingCount} processing`] : []),
      ],
    } as SystemNodeData,
  });

  // Orchestrator -> Agent Fleet (single delegation edge replaces per-agent routing)
  edge("e-orch-fleet", "router-orchestrator", "sys-fleet", "#a855f7", { label: "delegate", opacity: 0.5, animated: processingCount > 0 });

  // Bypass paths: Config Gates -> Fleet (dashed amber, replaces per-agent bypass edges)
  edge("e-bypass-fleet", "sys-config", "sys-fleet", "#f59e0b", { dashed: true, opacity: 0.5, label: "auto-fix bypass" });

  // =======================================================
  // RIGHT COLUMN: ENFORCEMENT & INTELLIGENCE
  // Y-aligned with the lanes they interact with so edges
  // run horizontally instead of crossing the entire graph.
  // =======================================================

  nodes.push({
    id: "sys-guardrails", type: "system", position: { x: RIGHT_COL_X, y: ARCH_ROW * 4.0 },
    data: { label: "Constitutional Gates", description: "G1-G11 DB-enforced (P2)", icon: "\u{1F6E1}\uFE0F", color: "bg-red-500/10 text-red-400", badges: ["Budget", "Commitment", "Voice", "Autonomy", "Reversibility", "Stakeholder", "Precedent", "Injection", "Auto-classify", "Spend cap", "Retrospective"] } as SystemNodeData,
  });
  nodes.push({
    id: "sys-permissions", type: "system", position: { x: RIGHT_COL_X, y: ARCH_ROW * 4.7 },
    data: { label: "Permission Grants", description: "Unified governance (ADR-017)", icon: "\u{1F511}", color: "bg-purple-500/10 text-purple-400", badges: ["Tools", "Adapters", "API clients"] } as SystemNodeData,
  });
  nodes.push({
    id: "sys-signals", type: "system", position: { x: RIGHT_COL_X, y: ARCH_ROW * 5.5 },
    data: { label: "Signal System", description: "ADR-014 \u2014 dimensional classification", icon: "\u{1F4E1}", color: "bg-cyan-500/10 text-cyan-400", badges: ["9 types", "15 contacts", "Auto-tier"] } as SystemNodeData,
  });
  nodes.push({
    id: "sys-voice", type: "system", position: { x: RIGHT_COL_X, y: ARCH_ROW * 6.25 },
    data: { label: "Voice System", description: "Email tone matching", icon: "\u{1F3A4}", color: "bg-pink-500/10 text-pink-400", badges: ["Profile builder", "Few-shot", "Tone scoring"] } as SystemNodeData,
  });

  // Enforcement connections — now horizontal (same Y-level as source)
  edge("e-taskgraph-guard", "sys-taskgraph", "sys-guardrails", "#ef4444", { opacity: 0.5, label: "guardCheck()" });
  edge("e-guard-perms", "sys-guardrails", "sys-permissions", "#a855f7", { opacity: 0.3 });

  // Fleet -> Signals (replaces triage-specific edge; signal extraction
  // happens across multiple agents — collapsing keeps Architecture at
  // subsystem level).
  edge("e-fleet-signals", "sys-fleet", "sys-signals", "#22d3ee", { opacity: 0.4, label: "extract" });
  // Voice -> Fleet (replaces responder-specific edge; voice profile is
  // consumed by responder + reviewer downstream).
  edge("e-voice-fleet", "sys-voice", "sys-fleet", "#ec4899", { opacity: 0.4, label: "tone match" });

  // =======================================================
  // DATA STORES
  // =======================================================
  const storeY = ARCH_ROW * 8;
  const topoSource = data.topology?.source;

  nodes.push({
    id: "store-pg", type: "store", position: { x: ARCH_COL * 0.5, y: storeY },
    data: { label: "PostgreSQL", description: "5 schemas \u2014 primary operational store", icon: "\u{1F418}", schemas: ["agent_graph", "inbox", "voice", "signal", "content"], status: "connected" } as StoreNodeData,
  });
  nodes.push({
    id: "store-neo4j", type: "store", position: { x: ARCH_COL * 2.5, y: storeY },
    data: { label: "Neo4j", description: "Learning layer (ADR-019) \u2014 graceful degradation", icon: "\u{1F578}\uFE0F", status: topoSource === "neo4j" ? "connected" : "degraded" } as StoreNodeData,
  });
  nodes.push({
    id: "store-redis", type: "store", position: { x: ARCH_COL * 4.5, y: storeY },
    data: { label: "Redis", description: "API key cache (AES-256-GCM)", icon: "\u{26A1}", status: "connected" } as StoreNodeData,
  });

  // Store connections
  edge("e-guard-pg", "sys-guardrails", "store-pg", "#22d3ee", { opacity: 0.4, label: "state transitions" });
  edge("e-signals-pg", "sys-signals", "store-pg", "#22d3ee", { opacity: 0.3, label: "signal schema" });
  edge("e-taskgraph-neo4j", "sys-taskgraph", "store-neo4j", "#22d3ee", { opacity: 0.3, dashed: true, label: "pattern extraction" });

  // =======================================================
  // OUTPUTS & SURFACES
  // =======================================================
  const outY = ARCH_ROW * 9.5;

  const outputs: Array<{ id: string; label: string; desc: string; icon: string; port?: number; stack?: string }> = [
    { id: "out-board-dash", label: "Board Dashboard", desc: "Workstation + Graph", icon: "\u{1F4CA}", port: 3200, stack: "Next.js 15" },
    { id: "out-inbox-dash", label: "Inbox Dashboard", desc: "Email ops view", icon: "\u{1F4E5}", port: 3100, stack: "Next.js 15" },
    { id: "out-actions", label: "Action Proposals", desc: "Email replies, PRs, tickets", icon: "\u{1F680}" },
    { id: "out-briefing", label: "Daily Briefing", desc: "Email + Slack digest", icon: "\u{1F4E8}" },
    { id: "out-archive", label: "Public Event Archive", desc: "Immutable, hash-chained (P3)", icon: "\u{1F4DA}" },
  ];

  outputs.forEach((o, i) => {
    nodes.push({
      id: o.id, type: "service", position: { x: i * (ARCH_COL * 1.2), y: outY },
      data: { label: o.label, description: o.desc, icon: o.icon, port: o.port, stack: o.stack } as ServiceNodeData,
    });
  });

  // Store \u2192 Output edges
  edge("e-pg-boarddash", "store-pg", "out-board-dash", "#818cf8", { opacity: 0.4 });
  edge("e-pg-inboxdash", "store-pg", "out-inbox-dash", "#818cf8", { opacity: 0.4 });
  edge("e-pg-archive", "store-pg", "out-archive", "#818cf8", { opacity: 0.3 });

  // Agent \u2192 Output action edges
  if (topoNodes.some(n => n.id === "executor-responder")) {
    edge("e-responder-actions", "agent-executor-responder", "out-actions", "#f59e0b", { opacity: 0.3, label: "email replies" });
  }
  if (topoNodes.some(n => n.id === "executor-coder")) {
    edge("e-coder-actions", "agent-executor-coder", "out-actions", "#06b6d4", { opacity: 0.3, label: "PRs" });
  }
  if (topoNodes.some(n => n.id === "executor-ticket")) {
    edge("e-ticket-actions", "agent-executor-ticket", "out-actions", "#f97316", { opacity: 0.3, label: "tickets" });
  }

  // Governance \u2192 key outputs
  edge("e-gov-boarddash", "gov-board", "out-board-dash", "#fbbf24", { dashed: true, opacity: 0.2, label: "operates" });

  // =======================================================
  // BOARD WORKSTATION (governance-type ingress)
  // =======================================================
  nodes.push({
    id: "board-workstation", type: "governance",
    position: { x: ARCH_COL * 5.5, y: srcY },
    data: {
      label: "Board Workstation",
      description: "5 input paths (auto-classified)",
      icon: "\u{1F3DB}\uFE0F",
      subtitle: "change \u2022 ask \u2022 research \u2022 intake \u2022 directives",
    } as GovernanceNodeData,
  });

  // Board Workstation \u2192 Task Graph (directives & commands)
  edge("e-bw-taskgraph", "board-workstation", "sys-taskgraph", "#fbbf24", { opacity: 0.5, label: "directives & commands" });
  // Board Workstation \u2192 Constitutional Gates (governance intake, dashed)
  edge("e-bw-guardrails", "board-workstation", "sys-guardrails", "#fbbf24", { dashed: true, opacity: 0.4, label: "governance intake" });
  // Board Workstation \u2192 Action Proposals (prompt-to-PR bypass, dashed)
  edge("e-bw-actions", "board-workstation", "out-actions", "#fbbf24", { dashed: true, opacity: 0.3, label: "prompt-to-PR" });

  return { nodes, edges };
}

/* ── Main Component ───────────────────────────────────── */

export default function SystemGraph() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("architecture");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivityMap>({});

  // Close inspector when switching views
  useEffect(() => {
    setSelectedNode(null);
  }, [viewMode]);

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNode((prev) => (prev?.id === node.id ? null : node));
  }, []);

  // Architecture view needs the same underlying data as unified (topology + signals).
  // Map viewMode to the API view parameter — architecture always fetches "unified".
  const apiView = viewMode === "architecture" ? "unified" : viewMode;

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/graph?view=${apiView}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGraphData(data);
    } catch (err) {
      console.warn("[graph] Fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [apiView]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);

    // Real-time agent activity polling (5s for live graph visualization)
    const fetchActivity = async () => {
      try {
        const res = await fetch('/api/ops?path=' + encodeURIComponent('/api/agents/status'));
        if (res.ok) {
          const data: unknown = await res.json();
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            // API returns { statuses: { agentId: {...} } } — unwrap
            const raw = data as Record<string, unknown>;
            const statuses = (raw.statuses || raw) as AgentActivityMap;
            setAgentActivity(statuses);
          }
        }
      } catch { /* silent — activity is best-effort */ }
    };
    fetchActivity();
    const activityInterval = setInterval(fetchActivity, 5_000);

    return () => {
      clearInterval(interval);
      clearInterval(activityInterval);
    };
  }, [fetchData]);

  // Graph node position persistence (Dustin: drag positions should stick)
  const POSITIONS_KEY = `optimus:graph:positions:${viewMode}`;
  function loadSavedPositions(): Record<string, { x: number; y: number }> {
    try { return JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}'); } catch { return {}; }
  }
  function saveNodePosition(id: string, x: number, y: number) {
    const positions = loadSavedPositions();
    positions[id] = { x, y };
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  }

  // Build graph when data, view, or activity changes
  useEffect(() => {
    if (!graphData) return;
    try {
      const builder = viewMode === "architecture" ? buildArchitectureGraph : buildUnifiedGraph;
      const { nodes: n, edges: e } = builder(graphData, agentActivity);
      // Merge saved positions over computed layout
      const saved = loadSavedPositions();
      const merged = n.map(node => {
        const pos = saved[node.id];
        return pos ? { ...node, position: { x: pos.x, y: pos.y } } : node;
      });
      setNodes(merged);
      setEdges(e);
    } catch (err) {
      console.error("[graph] Failed to build graph:", err);
    }
  }, [graphData, viewMode, agentActivity, setNodes, setEdges]);

  const signalSummary = useMemo(() => {
    const s = graphData?.signals || {};
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      total: n(s.linear_signals_today) + n(s.github_signals_today) + n(s.transcript_signals_today),
      linear: n(s.linear_signals_today),
      github: n(s.github_signals_today),
      transcript: n(s.transcript_signals_today),
      intents: n(s.intents_pending),
      workItems: n(s.work_items_active),
    };
  }, [graphData]);

  const topoSource = graphData?.topology?.source;

  const inspectorOpen = selectedNode !== null;

  return (
    <div className="w-full h-full flex flex-col md:flex-row">
      <div className={`h-full transition-all duration-200 ease-in-out ${inspectorOpen ? "md:w-[65%]" : "w-full"}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDragStop={(_, node) => saveNodePosition(node.id, node.position.x, node.position.y)}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "smoothstep",
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1a1a25" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === "agent") return "#6366f1";
            if (node.type === "router") return "#3b82f6";
            if (node.type === "source") return "#3f3f46";
            if (node.type === "tier") return "#f59e0b";
            if (node.type === "destination") return "#818cf8";
            if (node.type === "governance") return "#fbbf24";
            if (node.type === "system") return "#6366f1";
            if (node.type === "store") return "#22d3ee";
            if (node.type === "service") return "#818cf8";
            if (node.type === "integration") return "#3f3f46";
            return "#27272a";
          }}
          maskColor="rgba(99, 102, 241, 0.1)"
          pannable
          zoomable
        />

        {/* Top-left: View controls */}
        <Panel position="top-left">
          <div className="flex items-center gap-1 bg-surface-raised/90 backdrop-blur border border-white/5 rounded-lg p-1">
            {(["architecture", "unified", "agents", "signals"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1.5 text-[10px] font-medium rounded-md transition-colors ${
                  viewMode === mode
                    ? mode === "architecture" ? "bg-amber-500/20 text-amber-300" : "bg-accent/20 text-accent-bright"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                }`}
              >
                {mode === "architecture" ? "Architecture" : mode === "unified" ? "Unified" : mode === "agents" ? "Agents" : "Signals"}
              </button>
            ))}
          </div>
        </Panel>

        {/* Top-right: Live stats */}
        <Panel position="top-right">
          <div className="bg-surface-raised/90 backdrop-blur border border-white/5 rounded-lg p-3 min-w-[180px]">
            <div className="text-[10px] font-medium text-zinc-400 mb-2">LIVE ACTIVITY</div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Signals today</span>
                <span className="text-[10px] font-medium text-zinc-300">{signalSummary.total}</span>
              </div>
              {signalSummary.linear > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-600 pl-2">Linear</span>
                  <span className="text-[10px] text-violet-400">{signalSummary.linear}</span>
                </div>
              )}
              {signalSummary.github > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-600 pl-2">GitHub</span>
                  <span className="text-[10px] text-zinc-400">{signalSummary.github}</span>
                </div>
              )}
              {signalSummary.transcript > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-600 pl-2">Transcripts</span>
                  <span className="text-[10px] text-orange-400">{signalSummary.transcript}</span>
                </div>
              )}
              <div className="border-t border-white/5 pt-1.5 mt-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-500">Pending intents</span>
                  <span className={`text-[10px] font-medium ${signalSummary.intents > 0 ? "text-amber-400" : "text-zinc-600"}`}>
                    {signalSummary.intents}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-500">Active work items</span>
                  <span className="text-[10px] font-medium text-emerald-400">{signalSummary.workItems}</span>
                </div>
              </div>
              {topoSource && (
                <div className="border-t border-white/5 pt-1.5 mt-1.5">
                  <div className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${topoSource === "neo4j" ? "bg-emerald-500" : topoSource === "postgres" ? "bg-amber-500" : "bg-red-500"}`} />
                    <span className="text-[9px] text-zinc-600">
                      {topoSource === "neo4j" ? "Neo4j connected" : topoSource === "postgres" ? "Postgres fallback" : "Graph offline"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* Bottom-left: Legend */}
        <Panel position="bottom-left">
          {viewMode === "architecture" ? (
            <div className="bg-surface-raised/90 backdrop-blur border border-white/5 rounded-lg p-3">
              <div className="text-[9px] font-medium text-zinc-500 mb-1.5">NODE TYPES</div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded bg-amber-500" />
                  <span className="text-[9px] text-zinc-500">Governance</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-zinc-400" />
                  <span className="text-[9px] text-zinc-500">Integration (external)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded bg-blue-500" />
                  <span className="text-[9px] text-zinc-500">Router (orchestrator)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded bg-indigo-500" />
                  <span className="text-[9px] text-zinc-500">System (subsystem)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-sky-400" />
                  <span className="text-[9px] text-zinc-500">Agent (cloud / Railway)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-orange-400" />
                  <span className="text-[9px] text-zinc-500">Agent (local / M1 runner)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded bg-cyan-500" />
                  <span className="text-[9px] text-zinc-500">Data store</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded bg-violet-500" />
                  <span className="text-[9px] text-zinc-500">Service / output</span>
                </div>
              </div>
              <div className="text-[9px] font-medium text-zinc-500 mt-2 mb-1.5">ACTIVITY</div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[9px] text-zinc-500">Processing (pulsing)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-indigo-400" />
                  <span className="text-[9px] text-zinc-500">Claimed task</span>
                </div>
              </div>
              <div className="text-[9px] font-medium text-zinc-500 mt-2 mb-1.5">DATA FLOW</div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-4 h-0 border-t border-emerald-500" />
                  <span className="text-[9px] text-zinc-500">Task flow (triage path)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-4 h-0 border-t-2 border-dashed border-amber-500" />
                  <span className="text-[9px] text-zinc-500">Bypass (pre-authorized)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-4 h-0 border-t border-dashed border-amber-500/50" />
                  <span className="text-[9px] text-zinc-500">Governance</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-4 h-0 border-t border-cyan-500" />
                  <span className="text-[9px] text-zinc-500">Data</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-surface-raised/90 backdrop-blur border border-white/5 rounded-lg p-3">
              <div className="text-[9px] font-medium text-zinc-500 mb-1.5">ROUTING</div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-4 h-0 border-t border-zinc-400" />
                  <span className="text-[9px] text-zinc-500">Source &rarr; Orchestrator</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-4 h-0 border-t border-emerald-500" />
                  <span className="text-[9px] text-zinc-500">Agent delegation</span>
                </div>
              </div>
              <div className="text-[9px] font-medium text-zinc-500 mt-2 mb-1.5">HEALTH</div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-[9px] text-zinc-500">&ge;90% success</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  <span className="text-[9px] text-zinc-500">&ge;70% success</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-400" />
                  <span className="text-[9px] text-zinc-500">&lt;70% success</span>
                </div>
              </div>
              <div className="text-[9px] font-medium text-zinc-500 mt-2 mb-1.5">DEPLOYMENT</div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] px-1 py-0.5 rounded bg-sky-500/10 text-sky-500">cloud</span>
                  <span className="text-[9px] text-zinc-500">Railway</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-500">local</span>
                  <span className="text-[9px] text-zinc-500">M1 runner</span>
                </div>
              </div>
            </div>
          )}
        </Panel>
      </ReactFlow>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/80 backdrop-blur-sm">
          <div className="text-sm text-zinc-500">Loading graph data...</div>
        </div>
      )}
      </div>

      {/* Inspector Panel — side panel on desktop, bottom sheet on mobile */}
      {inspectorOpen && selectedNode && (
        <div className="md:w-[35%] h-[40vh] md:h-full flex-shrink-0 border-t md:border-t-0 border-white/10 overflow-y-auto">
          <InspectorPanel
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
          />
        </div>
      )}
    </div>
  );
}
