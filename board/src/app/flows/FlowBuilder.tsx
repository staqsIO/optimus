"use client";

import { useReducer, useEffect, useState, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { computeAutoWires } from "./builder/intent-labels";
import type {
  FlowBuilderState,
  BuilderAction,
  FlowStepDraft,
  SignalCatalogEntry,
  ToolCatalogEntry,
} from "./builder/types";
import SignalPicker from "./builder/SignalPicker";
import StepEditor from "./builder/StepEditor";
import FlowSettings from "./builder/FlowSettings";
import FlowSummary from "./builder/FlowSummary";
import TestSandbox from "./builder/TestSandbox";

/* ───────── Helpers ───────── */

let _stepCounter = 0;
function makeStepId(): string {
  return `step-${Date.now()}-${++_stepCounter}`;
}

function newStep(): FlowStepDraft {
  return { id: makeStepId(), toolId: null, config: {}, outputSignalType: null };
}

/* ───────── Reducer ───────── */

const INITIAL_STATE: FlowBuilderState = {
  name: "",
  description: "",
  triggerSignalType: null,
  steps: [newStep()],
  maxDepth: 8,
  timeoutMs: 30000,
  retryPolicy: { strategy: "none", max_retries: 3 },
  savedFlowId: null,
  saving: false,
  error: null,
};

function reducer(state: FlowBuilderState, action: BuilderAction): FlowBuilderState {
  switch (action.type) {
    case "SET_NAME":
      return { ...state, name: action.name, error: null };
    case "SET_DESCRIPTION":
      return { ...state, description: action.description };
    case "SET_TRIGGER":
      return { ...state, triggerSignalType: action.signalType || null, error: null };
    case "ADD_STEP":
      return { ...state, steps: [...state.steps, newStep()] };
    case "REMOVE_STEP":
      return { ...state, steps: state.steps.filter((s) => s.id !== action.stepId) };
    case "MOVE_STEP": {
      const idx = state.steps.findIndex((s) => s.id === action.stepId);
      if (idx < 0) return state;
      const target = action.direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= state.steps.length) return state;
      const next = [...state.steps];
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...state, steps: next };
    }
    case "SET_STEP_TOOL": {
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.id === action.stepId ? { ...s, toolId: action.toolId, config: {} } : s,
        ),
      };
    }
    case "SET_STEP_CONFIG":
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.id === action.stepId ? { ...s, config: { ...s.config, [action.key]: action.value } } : s,
        ),
      };
    case "SET_STEP_OUTPUT":
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.id === action.stepId ? { ...s, outputSignalType: action.signalType } : s,
        ),
      };
    case "SET_MAX_DEPTH":
      return { ...state, maxDepth: Math.max(1, Math.min(32, action.value)) };
    case "SET_TIMEOUT":
      return { ...state, timeoutMs: action.value };
    case "SET_RETRY":
      return { ...state, retryPolicy: { strategy: action.strategy, max_retries: action.max_retries } };
    case "SAVE_START":
      return { ...state, saving: true, error: null };
    case "SAVE_SUCCESS":
      return { ...state, saving: false, savedFlowId: action.flowId };
    case "SAVE_ERROR":
      return { ...state, saving: false, error: action.error };
    case "RESET":
      return { ...INITIAL_STATE, steps: [newStep()] };
    case "LOAD_FLOW":
      return {
        ...state,
        name: action.flow.name,
        description: action.flow.description ?? "",
        triggerSignalType: action.flow.trigger_signal_type,
        steps: action.flow.steps.map((s) => ({
          id: makeStepId(),
          toolId: s.tool_id,
          config: s.config ?? {},
          outputSignalType: s.output_signal_type ?? null,
        })),
        maxDepth: action.flow.max_depth,
        timeoutMs: action.flow.timeout_ms,
        retryPolicy: action.flow.retry_policy
          ? { strategy: action.flow.retry_policy.strategy as FlowBuilderState["retryPolicy"]["strategy"], max_retries: action.flow.retry_policy.max_retries ?? 3 }
          : { strategy: "none", max_retries: 3 },
        savedFlowId: action.flow.id,
        error: null,
      };
    default:
      return state;
  }
}

/* ───────── Component ───────── */

export default function FlowBuilder({ onDone }: { onDone: () => void }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [signals, setSignals] = useState<SignalCatalogEntry[]>([]);
  const [tools, setTools] = useState<ToolCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);

  // Fetch catalogs once on mount
  useEffect(() => {
    Promise.all([
      opsFetch<{ signal_types: SignalCatalogEntry[] }>("/api/flows/catalog/signals"),
      opsFetch<{ tools: ToolCatalogEntry[] }>("/api/flows/catalog/tools"),
    ]).then(([sigRes, toolRes]) => {
      if (sigRes?.signal_types) setSignals(sigRes.signal_types);
      if (toolRes?.tools) setTools(toolRes.tools);
      setCatalogLoading(false);
    });
  }, []);

  const handleSave = useCallback(async () => {
    dispatch({ type: "SAVE_START" });

    // Resolve auto-wired config: empty fields with a wire get {{source.field}} templates
    const triggerSchema = state.triggerSignalType
      ? signals.find((s) => s.signal_type === state.triggerSignalType)?.payload_schema
      : undefined;

    const resolvedSteps = state.steps
      .filter((s) => s.toolId)
      .map((s, i) => {
        const tool = tools.find((t) => t.tool_id === s.toolId);
        const params = tool?.parameters ?? {};

        // Build previous step outputs for auto-wire
        const prevOutputs = state.steps.slice(0, i)
          .filter((ps) => ps.toolId)
          .map((ps, pi) => ({
            stepIndex: pi,
            toolId: ps.toolId!,
            outputSchema: tools.find((t) => t.tool_id === ps.toolId)?.output_schema ?? {},
          }));

        const wires = computeAutoWires(params, triggerSchema, prevOutputs);

        // Merge: manual values take priority, auto-wired empty fields get template refs
        const config: Record<string, string> = {};
        for (const key of Object.keys(params)) {
          if (s.config[key]) {
            config[key] = s.config[key];
          } else if (wires[key]) {
            config[key] = `{{${wires[key]!.fromLabel}}}`;
          }
        }

        return {
          tool_id: s.toolId,
          config,
          ...(s.outputSignalType ? { output_signal_type: s.outputSignalType } : {}),
        };
      });

    const body = {
      name: state.name.trim(),
      trigger_signal_type: state.triggerSignalType,
      description: state.description.trim() || null,
      steps: resolvedSteps,
      max_depth: state.maxDepth,
      timeout_ms: state.timeoutMs,
      retry_policy: state.retryPolicy,
      created_by: "board",
    };

    const res = await opsPost<{ flow: { id: string } }>("/api/flows", body);

    if (!res.ok) {
      dispatch({ type: "SAVE_ERROR", error: res.error });
      return;
    }

    const flowData = res.data;
    if (flowData?.flow?.id) {
      dispatch({ type: "SAVE_SUCCESS", flowId: flowData.flow.id });
    } else {
      dispatch({ type: "SAVE_ERROR", error: "Unexpected response" });
    }
  }, [state, signals, tools]);

  if (catalogLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
        Loading catalogs...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold text-zinc-300 uppercase tracking-widest">
            {state.savedFlowId ? "Flow Saved" : "New Flow"}
          </h1>
          <button
            onClick={() => { dispatch({ type: "RESET" }); onDone(); }}
            className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            {state.savedFlowId ? "Back to Monitor" : "Cancel"}
          </button>
        </div>

        {/* Section 1: Trigger */}
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
            1. Trigger Signal
          </h2>
          <SignalPicker
            signals={signals}
            selected={state.triggerSignalType}
            onSelect={(st) => dispatch({ type: "SET_TRIGGER", signalType: st })}
          />
        </section>

        {/* Section 2: Steps */}
        {state.triggerSignalType && (
          <section>
            <h2 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
              2. Steps
            </h2>
            <div>
              {state.steps.map((step, i) => (
                <StepEditor
                  key={step.id}
                  step={step}
                  index={i}
                  isFirst={i === 0}
                  isLast={i === state.steps.length - 1}
                  tools={tools}
                  signals={signals}
                  triggerSignalType={state.triggerSignalType}
                  previousSteps={state.steps.slice(0, i)}
                  onSetTool={(toolId) => dispatch({ type: "SET_STEP_TOOL", stepId: step.id, toolId })}
                  onSetConfig={(key, value) => dispatch({ type: "SET_STEP_CONFIG", stepId: step.id, key, value })}
                  onSetOutput={(signalType) => dispatch({ type: "SET_STEP_OUTPUT", stepId: step.id, signalType })}
                  onRemove={() => dispatch({ type: "REMOVE_STEP", stepId: step.id })}
                  onMove={(dir) => dispatch({ type: "MOVE_STEP", stepId: step.id, direction: dir })}
                />
              ))}
            </div>
            <button
              onClick={() => dispatch({ type: "ADD_STEP" })}
              className="text-xs text-zinc-600 hover:text-accent-bright transition-colors mt-1 ml-9"
            >
              + Add step
            </button>
          </section>
        )}

        {/* Section 3: Settings */}
        {state.triggerSignalType && state.steps.length > 0 && (
          <section>
            <h2 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
              3. Settings
            </h2>
            <FlowSettings state={state} dispatch={dispatch} />
          </section>
        )}

        {/* Section 4: Review & Save */}
        {state.triggerSignalType && state.steps.length > 0 && state.name.trim() && !state.savedFlowId && (
          <section>
            <h2 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
              4. Review & Save
            </h2>
            <FlowSummary state={state} tools={tools} onSave={handleSave} />
          </section>
        )}

        {/* Section 5: Test Sandbox (after save) */}
        {state.savedFlowId && state.triggerSignalType && (
          <section>
            <h2 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
              5. Test with Sample Data
            </h2>
            <TestSandbox flowId={state.savedFlowId} triggerSignalType={state.triggerSignalType} />
          </section>
        )}
      </div>
    </div>
  );
}
