export interface RunSummary {
  id: string;
  type: string;
  title: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  budget_usd: string | null;
  trigger_source: string;
  item_count: string;
  agent_count: string;
  total_cost_usd: string;
  duration_ms: string | null;
}

export interface RunTreeItem {
  id: string;
  type: string;
  title: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  parent_id: string | null;
  delegation_depth: number;
  metadata: Record<string, unknown>;
  budget_usd: string | null;
  created_at: string;
  updated_at: string;
  duration_ms: number;
}

export interface RunEdge {
  id: string;
  from_id: string;
  to_id: string;
  edge_type: "decomposes_into" | "blocks" | "depends_on";
}

export interface RunCost {
  task_id: string;
  cost_usd: string;
  total_tokens: string;
  invocation_count: string;
}

export interface RunTreeResponse {
  root: RunTreeItem;
  items: RunTreeItem[];
  edges: RunEdge[];
  costs: RunCost[];
}

export interface ActivityStep {
  id: string;
  work_item_id: string;
  parent_step_id: string | null;
  depth: number;
  agent_id: string | null;
  step_type: string;
  description: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
  duration_ms: number;
  work_item_title: string | null;
}

export interface StateTransition {
  id: string;
  work_item_id: string;
  from_state: string;
  to_state: string;
  agent_id: string;
  cost_usd: string;
  reason: string | null;
  guardrail_checks_json: unknown;
  created_at: string;
  work_item_title: string | null;
}
