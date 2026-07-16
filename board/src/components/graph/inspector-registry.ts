/**
 * Inspector Section Registry — declarative config for all node type drill-downs.
 *
 * Each node type maps to SectionConfig[] — the InspectorPanel renders them
 * using the generic renderers. Adding node type N+1 = ~15 lines of config here.
 *
 * IMPORTANT: Every transform must match the ACTUAL API response shape.
 * See autobot-inbox/src/api-routes/ for endpoint definitions.
 */

import { getWriteup, getAgentWriteup } from "./writeups";

export type Renderer = "key-value" | "timeline" | "table" | "meter" | "sparkline" | "writeup";

export interface SectionConfig {
  id: string;
  title: string;
  /**
   * OPS API path (proxied through /api/ops?path=...).
   * Use "static" to skip fetch and populate from node.data directly.
   */
  endpoint: string;
  /** Build query params from the selected node */
  params?: (node: NodeRef) => Record<string, string>;
  renderer: Renderer;
  columns?: string[];
  fields?: string[];
  refreshInterval?: number;
  /** Transform raw API response before passing to renderer */
  transform?: (data: unknown, node?: NodeRef) => unknown;
  /** For static sections — extract display data from the node itself */
  staticData?: (node: NodeRef) => Record<string, unknown>;
}

export type NodeRef = { id: string; type: string; data: Record<string, unknown> };

type NodeType = string;

function agentIdFromNode(node: NodeRef): string {
  return (node.data.agentId as string) || node.id.replace(/^(agent-|arch-)/, "");
}

// ── Signal field mapping for source/integration nodes ─────────────────────
const signalFieldMap: Record<string, string> = {
  "Gmail": "webhook_total_today",
  "Email": "webhook_total_today",
  "Linear": "linear_signals_today",
  "GitHub": "github_signals_today",
  "Google Drive / tl;dv": "transcript_signals_today",
  "tl;dv": "transcript_signals_today",
};

function signalCountForNode(data: unknown, node?: NodeRef): Record<string, unknown> {
  const label = (node?.data?.label as string) || "";
  const d = data as Record<string, number>;
  const field = signalFieldMap[label];
  if (field && d?.[field] !== undefined) {
    return { "Signals Today": d[field] };
  }
  // Not yet wired (Slack, Telegram, etc.)
  return { "Signals Today": 0, "Status": "Channel active — signal counting not yet wired" };
}

// ── System node section resolver ─────────────────────────────────────────
// System nodes share a type but need different data per node.id.
function systemSections(node: NodeRef): SectionConfig[] {
  const id = node.id;

  if (id === "sys-taskgraph") {
    return [
      {
        id: "sys-taskgraph-queues",
        title: "Queue Depth by Agent",
        endpoint: "/api/pipeline/health",
        renderer: "table",
        columns: ["agent_id", "created", "assigned", "in_progress", "in_review", "total_active"],
        transform: (data: unknown) => {
          const d = data as { queues?: Array<Record<string, unknown>> };
          return d?.queues || [];
        },
      },
      {
        id: "sys-taskgraph-stuck",
        title: "Stuck Items",
        endpoint: "/api/pipeline/health",
        renderer: "table",
        columns: ["id", "title", "assigned_to", "status", "minutes_since_update"],
        transform: (data: unknown) => {
          const d = data as { stuck?: Array<Record<string, unknown>> };
          return d?.stuck || [];
        },
      },
      {
        id: "sys-taskgraph-throughput",
        title: "Throughput (24h)",
        endpoint: "/api/pipeline/throughput",
        renderer: "sparkline",
      },
    ];
  }

  if (id === "sys-guardrails") {
    return [
      {
        id: "sys-guardrails-gates",
        title: "Constitutional Gates",
        endpoint: "/api/gates",
        renderer: "table",
        columns: ["gate", "name", "passing"],
        transform: (data: unknown) => {
          const d = data as { gates?: Record<string, { passing?: boolean | null; name?: string; reason?: string; [k: string]: unknown }> };
          if (!d?.gates) return [];
          return Object.entries(d.gates).map(([gate, info]) => ({
            gate,
            name: info.name || gate,
            passing: info.passing === true ? "PASS" : info.passing === false ? "FAIL" : "AWAITING DATA",
          }));
        },
      },
      {
        id: "sys-guardrails-summary",
        title: "Gate Summary",
        endpoint: "/api/gates",
        renderer: "key-value",
        transform: (data: unknown) => {
          const d = data as { summary?: { passing?: number; total?: number; allPassing?: boolean | null; awaiting?: number } };
          const passing = d?.summary?.passing ?? 0;
          const total = d?.summary?.total ?? 0;
          const awaiting = d?.summary?.awaiting ?? (total - passing);
          return {
            "Passing": passing,
            "Total": total,
            "Awaiting Data": awaiting > 0 ? awaiting : "—",
            "All Passing": d?.summary?.allPassing === true ? "Yes" : d?.summary?.allPassing === false ? "No" : "Insufficient data",
          };
        },
      },
    ];
  }

  if (id === "sys-permissions") {
    return [
      {
        id: "sys-permissions-health",
        title: "Permission System",
        endpoint: "/api/pipeline/health",
        renderer: "key-value",
        transform: (data: unknown) => {
          const d = data as { queues?: unknown[]; stuck?: unknown[] };
          return {
            "Active Queues": Array.isArray(d?.queues) ? d.queues.length : 0,
            "Stuck Items": Array.isArray(d?.stuck) ? d.stuck.length : 0,
          };
        },
      },
    ];
  }

  if (id === "sys-toolbox") {
    return [
      {
        id: "sys-toolbox-health",
        title: "Tool Sandbox Status",
        endpoint: "/api/pipeline/health",
        renderer: "key-value",
        transform: (data: unknown) => {
          const d = data as { queues?: unknown[]; stuck?: unknown[] };
          return {
            "Active Queues": Array.isArray(d?.queues) ? d.queues.length : 0,
            "Stuck Items": Array.isArray(d?.stuck) ? d.stuck.length : 0,
          };
        },
      },
    ];
  }

  if (id === "sys-signals") {
    return [
      {
        id: "sys-signals-summary",
        title: "Signal Summary",
        endpoint: "/api/governance/signals-summary",
        renderer: "key-value",
        fields: [
          "linear_signals_today",
          "github_signals_today",
          "transcript_signals_today",
          "webhook_total_today",
          "signal_only_today",
          "intents_pending",
          "work_items_active",
        ],
      },
    ];
  }

  if (id === "sys-config") {
    return [
      {
        id: "sys-config-signals",
        title: "Signal Counts",
        endpoint: "/api/governance/signals-summary",
        renderer: "key-value",
        fields: ["linear_signals_today", "github_signals_today", "transcript_signals_today", "webhook_total_today"],
      },
      {
        id: "sys-config-bypass",
        title: "Recent Bypass Activity (7d)",
        endpoint: "/api/pipeline/bypass-activity",
        renderer: "table",
        columns: ["title", "assigned_to", "source", "status"],
        refreshInterval: 30_000,
        transform: (data: unknown) => {
          const d = data as { items?: Array<Record<string, unknown>> };
          return d?.items || [];
        },
      },
      {
        id: "sys-config-gates",
        title: "Config Gate Details",
        endpoint: "static",
        renderer: "key-value",
        staticData: (n: NodeRef) => {
          const cg = n.data.configGates as { linear?: { watchedTeams?: string[]; watchedProjects?: string[] }; github?: { repos?: string[] } } | undefined;
          const result: Record<string, unknown> = {};
          if (cg?.linear?.watchedTeams?.length) result["Linear Teams"] = cg.linear.watchedTeams.join(", ");
          if (cg?.linear?.watchedProjects?.length) result["Linear Projects"] = cg.linear.watchedProjects.join(", ");
          if (cg?.github?.repos?.length) result["GitHub Repos"] = cg.github.repos.join(", ");
          return result;
        },
      },
    ];
  }

  if (id === "sys-adapter" || id === "sys-webhook" || id === "sys-router") {
    return [
      {
        id: `${id}-signals`,
        title: "Signal Counts",
        endpoint: "/api/governance/signals-summary",
        renderer: "key-value",
        fields: ["linear_signals_today", "github_signals_today", "transcript_signals_today", "webhook_total_today"],
      },
    ];
  }

  // sys-voice, sys-eventbus — static from node.data
  return [
    {
      id: `${id}-info`,
      title: "Details",
      endpoint: "static",
      renderer: "key-value",
      staticData: (n: NodeRef) => {
        const result: Record<string, unknown> = {};
        if (n.data.label) result["Component"] = n.data.label;
        if (n.data.description) result["Description"] = n.data.description;
        const badges = n.data.badges as string[] | undefined;
        if (badges?.length) result["Features"] = badges.join(", ");
        return result;
      },
    },
  ];
}

export const inspectorRegistry: Record<NodeType, SectionConfig[]> = {
  agent: [
    {
      id: "agent-queue",
      title: "Active Queue",
      endpoint: "/api/pipeline/health",
      renderer: "table",
      columns: ["status", "count"],
      transform: (data: unknown, node?: NodeRef) => {
        const d = data as { queues?: Array<{ agent_id: string; created: number; assigned: number; in_progress: number; in_review: number; blocked: number }> };
        if (!d?.queues || !node) return [];
        const aid = agentIdFromNode(node);
        const match = d.queues.find((q) => q.agent_id === aid);
        if (!match) return [{ status: "No items", count: 0 }];
        return [
          { status: "Created", count: match.created },
          { status: "Assigned", count: match.assigned },
          { status: "In Progress", count: match.in_progress },
          { status: "In Review", count: match.in_review },
          { status: "Blocked", count: match.blocked },
        ].filter((r) => r.count > 0);
      },
      params: (node) => ({ agent_id: agentIdFromNode(node) }),
    },
    {
      id: "agent-performance",
      title: "Performance (7d)",
      endpoint: "/api/pipeline/agent-stats",
      renderer: "key-value",
      transform: (data: unknown) => {
        const d = data as {
          work_items?: { completed: number; failed: number; active: number; total: number };
          activity_steps_7d?: number;
          total_transitions_7d?: number;
          avg_task_duration_s?: number | null;
        };
        if (!d?.work_items) return { "Status": "No data" };
        const wi = d.work_items;
        const total = wi.completed + wi.failed;
        const rate = total > 0 ? `${Math.round((wi.completed / total) * 100)}%` : "—";
        const avgDur = d.avg_task_duration_s != null
          ? d.avg_task_duration_s > 60 ? `${(d.avg_task_duration_s / 60).toFixed(1)}m` : `${Math.round(d.avg_task_duration_s)}s`
          : "—";
        return {
          "Completed": wi.completed,
          "Failed": wi.failed,
          "Active": wi.active,
          "Success Rate": rate,
          "Activity Steps": d.activity_steps_7d || 0,
          "State Transitions": d.total_transitions_7d || 0,
          "Avg Duration": avgDur,
        };
      },
      params: (node) => ({ agent_id: agentIdFromNode(node) }),
    },
    {
      id: "agent-activity",
      title: "Recent Activity",
      endpoint: "/api/activity",
      renderer: "timeline",
      refreshInterval: 30_000,
      params: (node) => ({ agent_id: agentIdFromNode(node), limit: "20" }),
      transform: (data: unknown) => {
        const d = data as { steps?: Array<Record<string, unknown>> };
        return d?.steps || [];
      },
    },
    {
      id: "agent-cost",
      title: "LLM Cost (24h)",
      endpoint: "/api/finance/summary",
      renderer: "meter",
      params: () => ({}),
      transform: (data: unknown) => {
        // API returns { summary: { totalExpenses, allocation, ... } }
        // Extract what we can for the meter — per-agent cost needs Tier 2 backend work
        const d = data as { summary?: { totalExpenses?: number; allocation?: { daily_budget?: number } } };
        const expenses = d?.summary?.totalExpenses ?? 0;
        const budget = d?.summary?.allocation?.daily_budget ?? 20;
        return { value: expenses, max: budget, label: "Daily Budget" };
      },
    },
  ],

  source: [
    {
      id: "source-signals",
      title: "Signal Activity",
      endpoint: "/api/governance/signals-summary",
      renderer: "key-value",
      transform: signalCountForNode,
    },
  ],

  integration: [
    {
      id: "integration-signals",
      title: "Signal Activity",
      endpoint: "/api/governance/signals-summary",
      renderer: "key-value",
      transform: signalCountForNode,
    },
  ],

  tier: [
    {
      id: "tier-items",
      title: "Queue by Agent",
      endpoint: "/api/pipeline/health",
      renderer: "table",
      columns: ["agent_id", "created", "assigned", "in_progress", "total_active"],
      transform: (data: unknown) => {
        const d = data as { queues?: Array<{ agent_id: string; created: number; assigned: number; in_progress: number; total_active: number }> };
        return d?.queues || [];
      },
    },
    {
      id: "tier-throughput",
      title: "Throughput (24h)",
      endpoint: "/api/pipeline/throughput",
      renderer: "sparkline",
    },
  ],

  governance: [
    {
      id: "gov-info",
      title: "Details",
      endpoint: "static",
      renderer: "key-value",
      staticData: (node: NodeRef) => {
        const result: Record<string, unknown> = {};
        if (node.data.label) result["Name"] = node.data.label;
        if (node.data.description) result["Description"] = node.data.description;
        if (node.data.subtitle) result["Details"] = node.data.subtitle;
        return result;
      },
    },
  ],

  router: [
    {
      id: "router-queue",
      title: "Active Queue",
      endpoint: "/api/pipeline/health",
      renderer: "table",
      columns: ["status", "count"],
      transform: (data: unknown, node?: NodeRef) => {
        const d = data as { queues?: Array<{ agent_id: string; created: number; assigned: number; in_progress: number; in_review: number; blocked: number }> };
        if (!d?.queues || !node) return [];
        const aid = agentIdFromNode(node);
        const match = d.queues.find((q) => q.agent_id === aid);
        if (!match) return [{ status: "No items", count: 0 }];
        return [
          { status: "Created", count: match.created },
          { status: "Assigned", count: match.assigned },
          { status: "In Progress", count: match.in_progress },
          { status: "In Review", count: match.in_review },
          { status: "Blocked", count: match.blocked },
        ].filter((r) => r.count > 0);
      },
      params: (node) => ({ agent_id: agentIdFromNode(node) }),
    },
    {
      id: "router-performance",
      title: "Performance (7d)",
      endpoint: "/api/pipeline/agent-stats",
      renderer: "key-value",
      transform: (data: unknown) => {
        const d = data as {
          work_items?: { completed: number; failed: number; active: number; total: number };
          activity_steps_7d?: number;
          total_transitions_7d?: number;
          avg_task_duration_s?: number | null;
        };
        if (!d?.work_items) return { "Status": "No data" };
        const wi = d.work_items;
        const total = wi.completed + wi.failed;
        const rate = total > 0 ? `${Math.round((wi.completed / total) * 100)}%` : "—";
        return {
          "Completed": wi.completed,
          "Failed": wi.failed,
          "Active": wi.active,
          "Success Rate": rate,
          "State Transitions": d.total_transitions_7d || 0,
        };
      },
      params: (node) => ({ agent_id: agentIdFromNode(node) }),
    },
    {
      id: "router-activity",
      title: "Recent Activity",
      endpoint: "/api/activity",
      renderer: "timeline",
      refreshInterval: 30_000,
      params: (node) => ({ agent_id: agentIdFromNode(node), limit: "20" }),
      transform: (data: unknown) => {
        const d = data as { steps?: Array<Record<string, unknown>> };
        return d?.steps || [];
      },
    },
  ],

  system: [], // Dynamically resolved — see getInspectorSections()

  store: [
    {
      id: "store-info",
      title: "Store Details",
      endpoint: "static",
      renderer: "key-value",
      staticData: (node: NodeRef) => {
        const result: Record<string, unknown> = {};
        if (node.data.label) result["Name"] = node.data.label;
        if (node.data.description) result["Description"] = node.data.description;
        const schemas = node.data.schemas as string[] | undefined;
        if (schemas?.length) result["Schemas"] = schemas.join(", ");
        if (node.data.status) result["Status"] = node.data.status;
        return result;
      },
    },
  ],

  service: [
    {
      id: "service-info",
      title: "Service Details",
      endpoint: "static",
      renderer: "key-value",
      staticData: (node: NodeRef) => {
        const result: Record<string, unknown> = {};
        if (node.data.label) result["Name"] = node.data.label;
        if (node.data.description) result["Description"] = node.data.description;
        if (node.data.port) result["Port"] = node.data.port;
        if (node.data.stack) result["Stack"] = node.data.stack;
        const features = node.data.features as string[] | undefined;
        if (features?.length) result["Features"] = features.join(", ");
        return result;
      },
    },
  ],

  destination: [
    {
      id: "dest-info",
      title: "Output Details",
      endpoint: "static",
      renderer: "key-value",
      staticData: (node: NodeRef) => {
        const result: Record<string, unknown> = {};
        if (node.data.label) result["Name"] = node.data.label;
        if (node.data.description) result["Description"] = node.data.description;
        return result;
      },
    },
  ],

  spec: [
    {
      id: "spec-status",
      title: "Section Status",
      endpoint: "/api/spec-graph/status",
      renderer: "key-value",
    },
  ],
};

// ── Writeup section builder ───────────────────────────────────────────
// Prepends a SPEC-linked writeup section to any node's inspector sections.
function writeupSection(node: NodeRef): SectionConfig | null {
  // For agent nodes, resolve by tier; for everything else, by node ID
  const writeup = node.type === "agent"
    ? getAgentWriteup((node.data.tier as string) || "")
    : getWriteup(node.id);

  if (!writeup) return null;

  return {
    id: `${node.id}-writeup`,
    title: "About",
    endpoint: "static",
    renderer: "writeup",
    staticData: () => ({ ...writeup }),
  };
}

/**
 * Resolve inspector sections for a node. System nodes are dynamically
 * resolved based on node.id. Governance nodes with specific IDs get
 * additional live data sections. All nodes get a SPEC writeup section
 * prepended when one exists.
 */
export function getInspectorSections(node: NodeRef): SectionConfig[] {
  const wu = writeupSection(node);
  const prefix = wu ? [wu] : [];

  if (node.type === "system") {
    return [...prefix, ...systemSections(node)];
  }

  if (node.type === "governance") {
    const base = inspectorRegistry.governance || [];
    const extra: SectionConfig[] = [];

    if (node.id === "gov-board") {
      extra.push({
        id: "gov-board-commands",
        title: "Recent Board Commands",
        endpoint: "/api/pipeline/health",
        renderer: "table",
        columns: ["title", "status", "assigned_to", "source"],
        transform: (data: unknown) => {
          const d = data as { boardCommands?: Array<Record<string, unknown>> };
          return d?.boardCommands || [];
        },
      });
    }

    if (node.id === "gov-spec") {
      extra.push({
        id: "gov-spec-status",
        title: "Implementation Status",
        endpoint: "/api/spec-graph/status",
        renderer: "key-value",
      });
    }

    return [...prefix, ...base, ...extra];
  }

  const typeSections = inspectorRegistry[node.type] || [];
  return [...prefix, ...typeSections];
}
