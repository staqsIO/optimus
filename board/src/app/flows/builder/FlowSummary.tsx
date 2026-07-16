"use client";

import type { FlowBuilderState, ToolCatalogEntry } from "./types";
import { getSignalLabel, getToolLabel } from "./intent-labels";

function formatTimeout(ms: number): string {
  if (ms < 60000) return `${ms / 1000}s`;
  return `${ms / 60000}m`;
}

export default function FlowSummary({
  state,
  tools,
  onSave,
}: {
  state: FlowBuilderState;
  tools: ToolCatalogEntry[];
  onSave: () => void;
}) {
  const errors: string[] = [];
  if (!state.name.trim()) errors.push("Flow name is required");
  if (!state.triggerSignalType) errors.push("Trigger signal is required");
  if (state.steps.length === 0) errors.push("At least one step is required");
  if (state.steps.some((s) => !s.toolId)) errors.push("All steps must have a tool selected");

  const valid = errors.length === 0;

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4 space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-zinc-200">{state.name || "(unnamed)"}</span>
          {state.description && (
            <span className="text-[10px] text-zinc-500 truncate">{state.description}</span>
          )}
        </div>

        {/* Trigger */}
        <div className="text-xs">
          <span className="text-zinc-500">Trigger:</span>{" "}
          <span className="text-cyan-400">
            {state.triggerSignalType ? getSignalLabel(state.triggerSignalType) : "(none)"}
          </span>
          {state.triggerSignalType && (
            <span className="text-zinc-600 ml-1 font-mono text-[10px]">{state.triggerSignalType}</span>
          )}
        </div>

        {/* Steps */}
        <div className="space-y-1">
          <span className="text-[10px] text-zinc-500 uppercase tracking-widest">
            Steps ({state.steps.length})
          </span>
          {state.steps.map((step, i) => {
            const tool = tools.find((t) => t.tool_id === step.toolId);
            return (
              <div key={step.id} className="flex items-center gap-2 text-xs pl-2">
                <span className="text-zinc-600 font-mono w-4 text-right">{i + 1}.</span>
                <span className="text-zinc-300">{step.toolId ? getToolLabel(step.toolId) : "(no tool)"}</span>
                {tool && (
                  <span className="text-[10px] text-zinc-600 font-mono">{tool.dispatch_mode}</span>
                )}
                {step.outputSignalType && (
                  <span className="text-[10px] text-cyan-400/60">
                    &rarr; {step.outputSignalType}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Settings */}
        <div className="flex items-center gap-4 text-[10px] text-zinc-600">
          <span>depth: {state.maxDepth}</span>
          <span>timeout: {formatTimeout(state.timeoutMs)}</span>
          <span>failure: {state.retryPolicy.strategy === "retry_step" ? `retry (${state.retryPolicy.max_retries}x)` : state.retryPolicy.strategy}</span>
        </div>
      </div>

      {/* Validation errors */}
      {errors.length > 0 && (
        <div className="space-y-1">
          {errors.map((err) => (
            <div key={err} className="text-xs text-red-400 flex items-center gap-1.5">
              <span className="text-red-500">&#9679;</span> {err}
            </div>
          ))}
        </div>
      )}

      {/* Save button */}
      <button
        onClick={onSave}
        disabled={!valid || state.saving}
        className={`w-full py-2 rounded-lg text-xs font-medium transition-colors
          ${valid && !state.saving
            ? "bg-accent text-white hover:bg-accent-dim"
            : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
          }`}
      >
        {state.saving ? "Saving..." : "Save Flow"}
      </button>

      {/* Error from save */}
      {state.error && (
        <div className="text-xs text-red-400 border border-red-500/20 rounded-lg p-2 bg-red-500/5">
          {state.error}
        </div>
      )}
    </div>
  );
}
