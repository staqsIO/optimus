/* ───────── Flow Builder Types ───────── */

export interface FlowStepDraft {
  id: string;
  toolId: string | null;
  config: Record<string, string>;
  outputSignalType: string | null;
}

export interface FlowBuilderState {
  name: string;
  description: string;
  triggerSignalType: string | null;
  steps: FlowStepDraft[];
  maxDepth: number;
  timeoutMs: number;
  retryPolicy: {
    strategy: "none" | "skip" | "retry_step";
    max_retries: number;
  };
  savedFlowId: string | null;
  saving: boolean;
  error: string | null;
}

export type BuilderAction =
  | { type: "SET_NAME"; name: string }
  | { type: "SET_DESCRIPTION"; description: string }
  | { type: "SET_TRIGGER"; signalType: string }
  | { type: "ADD_STEP" }
  | { type: "REMOVE_STEP"; stepId: string }
  | { type: "MOVE_STEP"; stepId: string; direction: "up" | "down" }
  | { type: "SET_STEP_TOOL"; stepId: string; toolId: string }
  | { type: "SET_STEP_CONFIG"; stepId: string; key: string; value: string }
  | { type: "SET_STEP_OUTPUT"; stepId: string; signalType: string | null }
  | { type: "SET_MAX_DEPTH"; value: number }
  | { type: "SET_TIMEOUT"; value: number }
  | { type: "SET_RETRY"; strategy: FlowBuilderState["retryPolicy"]["strategy"]; max_retries: number }
  | { type: "SAVE_START" }
  | { type: "SAVE_SUCCESS"; flowId: string }
  | { type: "SAVE_ERROR"; error: string }
  | { type: "RESET" }
  | { type: "LOAD_FLOW"; flow: FlowDefinition };

/* ───────── API Response Types ───────── */

export interface SignalCatalogEntry {
  signal_type: string;
  source_adapter: string;
  label: string;
  category: string;
  description: string;
  payload_schema?: Record<string, string>;
}

/**
 * A tool's parameter descriptor. Two shapes:
 *   - Shorthand: `'string'` / `'number'` / ... — bare type, no constraints.
 *   - Rich:     `{ type, enum?, default? }` — exposes enum/default to the UI.
 */
export type ToolParamDescriptor =
  | string
  | { type: string; enum?: string[]; default?: unknown };

export interface ToolCatalogEntry {
  tool_id: string;
  name: string;
  label: string;
  description: string;
  category: string;
  dispatch_mode: "function" | "agent" | "hybrid";
  parameters: Record<string, ToolParamDescriptor>;
  output_schema?: Record<string, string>;
  /** True for flow-native tools/agents (from flow-tools/ and flow-agents/). */
  native?: boolean;
}

export interface FlowDefinition {
  id: string;
  name: string;
  version: number;
  description: string | null;
  trigger_signal_type: string;
  steps: { tool_id: string; config: Record<string, string>; output_signal_type?: string }[];
  is_active: boolean;
  max_depth: number;
  timeout_ms: number;
  retry_policy: { strategy: string; max_retries?: number } | null;
  created_at: string;
}

export interface FlowExecution {
  id: string;
  flow_definition_id: string;
  flow_name?: string;
  status: string;
  depth: number;
  dry_run: boolean;
  parent_execution_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
}
