/**
 * Widget Registry — defines available dashboard widgets.
 * Each widget wraps an existing board component for dynamic rendering.
 * Widget IDs are stable identifiers stored in user preferences.
 */

export interface WidgetDef {
  id: string;
  name: string;
  description: string;
  category: "monitoring" | "operations" | "data" | "system";
  /** Dynamic import path relative to board/src/ */
  component: string;
  defaultSize: { cols: number; rows: number };
  /** If set, only users with this role (or higher) see it */
  requiredRole?: "admin" | "member";
}

export const WIDGETS: WidgetDef[] = [
  {
    id: "actions",
    name: "Action Required",
    description: "Pending HITL, triage, and campaign items needing board attention",
    category: "operations",
    component: "@/components/ActionRequired",
    defaultSize: { cols: 2, rows: 1 },
    requiredRole: "admin",
  },
  {
    id: "agent-status",
    name: "Agent Status",
    description: "Live status of all 18 agents across tiers",
    category: "monitoring",
    component: "@/components/AgentStatus",
    defaultSize: { cols: 1, rows: 1 },
  },
  {
    id: "cost-24h",
    name: "Cost (24h)",
    description: "LLM spend in the last 24 hours vs daily budget",
    category: "monitoring",
    component: "@/components/CostWidget",
    defaultSize: { cols: 1, rows: 1 },
  },
  {
    id: "campaigns",
    name: "Active Campaigns",
    description: "Running and recent campaign status",
    category: "operations",
    component: "@/components/CampaignsWidget",
    defaultSize: { cols: 1, rows: 1 },
  },
  {
    id: "signals",
    name: "Recent Signals",
    description: "Latest extracted signals from all channels",
    category: "data",
    component: "@/components/SignalsWidget",
    defaultSize: { cols: 1, rows: 1 },
  },
  {
    id: "triage",
    name: "Triage Queue",
    description: "Messages awaiting triage classification",
    category: "operations",
    component: "@/components/TriageWidget",
    defaultSize: { cols: 1, rows: 1 },
    requiredRole: "admin",
  },
  {
    id: "services",
    name: "Scheduled Services",
    description: "Cron-scheduled services and their run status",
    category: "system",
    component: "@/components/ServicesWidget",
    defaultSize: { cols: 1, rows: 1 },
    requiredRole: "admin",
  },
  {
    id: "graph",
    name: "System Graph",
    description: "Task graph visualization and health metrics",
    category: "monitoring",
    component: "@/components/SystemGraphWidget",
    defaultSize: { cols: 2, rows: 1 },
    requiredRole: "admin",
  },
  {
    id: "optimus-mcp",
    name: "Optimus MCP",
    description: "MCP tool server status and recent invocations",
    category: "system",
    component: "@/components/OptimusMcpWidget",
    defaultSize: { cols: 1, rows: 1 },
    requiredRole: "admin",
  },
];

/** Preset configurations for different user roles / workflows */
export interface DashboardPreset {
  id: string;
  name: string;
  description: string;
  widgets: string[];
}

export const PRESETS: DashboardPreset[] = [
  {
    id: "daily-ops",
    name: "Daily Ops",
    description: "Eric's daily operations view",
    widgets: ["actions", "agent-status", "cost-24h", "campaigns"],
  },
  {
    id: "board-overview",
    name: "Board Overview",
    description: "High-level board view for strategy review",
    widgets: ["cost-24h", "campaigns", "services", "graph"],
  },
  {
    id: "sales-view",
    name: "Sales View",
    description: "Signals and campaign focus for sales members",
    widgets: ["signals", "campaigns"],
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Just the essentials",
    widgets: ["actions", "signals"],
  },
];

/** Get the default preset for a given role */
export function getDefaultPreset(role: string): DashboardPreset {
  switch (role) {
    case "admin":
      return PRESETS.find((p) => p.id === "daily-ops")!;
    case "member":
      return PRESETS.find((p) => p.id === "minimal")!;
    default:
      return PRESETS.find((p) => p.id === "minimal")!;
  }
}

/** Get widgets available for a given role */
export function getAvailableWidgets(role: string): WidgetDef[] {
  return WIDGETS.filter((w) => {
    if (!w.requiredRole) return true;
    if (role === "admin") return true;
    return w.requiredRole === "member" || w.requiredRole === role;
  });
}

/** Resolve widget IDs to WidgetDefs, filtering out invalid/unauthorized ones */
export function resolveWidgets(widgetIds: string[], role: string): WidgetDef[] {
  const available = new Set(getAvailableWidgets(role).map((w) => w.id));
  return widgetIds
    .filter((id) => available.has(id))
    .map((id) => WIDGETS.find((w) => w.id === id)!)
    .filter(Boolean);
}
