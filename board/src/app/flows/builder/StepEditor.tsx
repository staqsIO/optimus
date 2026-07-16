"use client";

import { useState, useMemo } from "react";
import type { FlowStepDraft, ToolCatalogEntry, SignalCatalogEntry } from "./types";
import { getToolLabel, computeAutoWires, parseWireTemplate } from "./intent-labels";
import type { WireSource } from "./intent-labels";
import ToolPicker from "./ToolPicker";
import OutputPicker from "./OutputPicker";
import StepPreview from "./StepPreview";
import FieldPicker, { buildFieldSources } from "./FieldPicker";

const MODE_BADGE: Record<string, string> = {
  function: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  agent:    "bg-violet-500/20 text-violet-400 border-violet-500/30",
  hybrid:   "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const NATIVE_BADGE = "bg-sky-500/20 text-sky-300 border-sky-500/30";

export default function StepEditor({
  step,
  index,
  isFirst,
  isLast,
  tools,
  signals,
  triggerSignalType,
  previousSteps,
  onSetTool,
  onSetConfig,
  onSetOutput,
  onRemove,
  onMove,
}: {
  step: FlowStepDraft;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  tools: ToolCatalogEntry[];
  signals: SignalCatalogEntry[];
  triggerSignalType: string | null;
  previousSteps: FlowStepDraft[];
  onSetTool: (toolId: string) => void;
  onSetConfig: (key: string, value: string) => void;
  onSetOutput: (signalType: string | null) => void;
  onRemove: () => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const [showToolPicker, setShowToolPicker] = useState(false);
  const [showOutput, setShowOutput] = useState(step.outputSignalType !== null);
  const [showPreview, setShowPreview] = useState(false);
  const [pickingParam, setPickingParam] = useState<string | null>(null);

  const tool = tools.find((t) => t.tool_id === step.toolId);
  const params = tool?.parameters ?? {};

  // Compute auto-wiring for this step's tool parameters
  const triggerSchema = useMemo(() => {
    if (!triggerSignalType) return undefined;
    return signals.find((s) => s.signal_type === triggerSignalType)?.payload_schema;
  }, [triggerSignalType, signals]);

  const prevStepOutputs = useMemo(() => {
    return previousSteps
      .filter((s) => s.toolId)
      .map((s, i) => {
        const t = tools.find((tool) => tool.tool_id === s.toolId);
        return {
          stepIndex: i,
          toolId: s.toolId!,
          outputSchema: t?.output_schema ?? {},
        };
      });
  }, [previousSteps, tools]);

  const wires = useMemo(() => {
    if (!step.toolId || Object.keys(params).length === 0) return {};
    return computeAutoWires(params, triggerSchema, prevStepOutputs);
  }, [step.toolId, params, triggerSchema, prevStepOutputs]);

  const fieldSources = useMemo(
    () => buildFieldSources(triggerSchema, prevStepOutputs),
    [triggerSchema, prevStepOutputs],
  );

  const pickingParamType = pickingParam
    ? (typeof params[pickingParam] === "string" ? (params[pickingParam] as string) : undefined)
    : undefined;

  return (
    <div className="relative flex gap-3">
      {/* Vertical connector line */}
      <div className="flex flex-col items-center w-6 shrink-0">
        <div className="w-6 h-6 rounded-full border border-white/20 bg-surface-raised flex items-center justify-center text-[10px] font-mono text-zinc-400 shrink-0">
          {index + 1}
        </div>
        {!isLast && <div className="flex-1 w-px bg-white/10 mt-1" />}
      </div>

      {/* Step card */}
      <div className="flex-1 border border-white/10 rounded-lg bg-white/[0.02] p-3 space-y-3 mb-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          {step.toolId ? (
            <button
              onClick={() => setShowToolPicker(true)}
              className="flex items-center gap-2 text-sm text-zinc-200 hover:text-accent-bright transition-colors"
            >
              <span>{getToolLabel(step.toolId)}</span>
              {tool && (
                <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${MODE_BADGE[tool.dispatch_mode] ?? MODE_BADGE.function}`}>
                  {tool.dispatch_mode}
                </span>
              )}
              {tool?.native && (
                <span
                  className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${NATIVE_BADGE}`}
                  title="Flow-native tool or agent (built for the flow engine, not a pipeline wrapper)"
                >
                  flow-native
                </span>
              )}
            </button>
          ) : (
            <button
              onClick={() => setShowToolPicker(true)}
              className="text-sm text-zinc-500 hover:text-accent-bright transition-colors"
            >
              Choose action...
            </button>
          )}

          <div className="ml-auto flex items-center gap-1">
            {!isFirst && (
              <button onClick={() => onMove("up")} className="text-[10px] text-zinc-600 hover:text-zinc-300 px-1" title="Move up">
                &#9650;
              </button>
            )}
            {!isLast && (
              <button onClick={() => onMove("down")} className="text-[10px] text-zinc-600 hover:text-zinc-300 px-1" title="Move down">
                &#9660;
              </button>
            )}
            <button onClick={onRemove} className="text-[10px] text-zinc-600 hover:text-red-400 px-1 ml-1" title="Remove step">
              &#10005;
            </button>
          </div>
        </div>

        {/* Config fields with auto-wiring + manual picker */}
        {step.toolId && Object.keys(params).length > 0 && (
          <div className="space-y-1.5">
            {Object.entries(params).map(([key, descriptor]) => {
              const rawValue = step.config[key] ?? "";
              const pickedWire = parseWireTemplate(rawValue);     // manual pick OR round-tripped wire
              const autoWire: WireSource | undefined = wires[key];
              const displayWire = pickedWire ?? (!rawValue ? autoWire : undefined);
              const isPilled = !!displayWire && (pickedWire !== null || !rawValue);
              const hasLiteralValue = !!rawValue && !pickedWire;

              // Descriptor is either a bare type string or { type, enum?, default? }.
              const paramType = typeof descriptor === "string" ? descriptor : descriptor.type;
              const paramEnum = typeof descriptor === "string" ? undefined : descriptor.enum;
              const paramTypeLabel = paramType || "value";

              return (
                <div key={key} className="flex items-center gap-2">
                  <label className="text-[10px] text-zinc-500 font-mono w-32 shrink-0 text-right">{key}</label>
                  <div className="flex-1 relative">
                    {isPilled ? (
                      // Pill: wired (either auto-wire or manually picked / rehydrated)
                      <div
                        className="w-full flex items-center gap-2 px-2 py-1 text-xs border rounded font-mono
                          bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
                      >
                        <span className="shrink-0">&#8592;</span>
                        <span className="flex-1 truncate">{displayWire!.fromLabel}</span>
                        <button
                          onClick={() => onSetConfig(key, "")}
                          className="shrink-0 text-[10px] text-emerald-500/60 hover:text-red-400 transition-colors"
                          title="Unwire"
                        >
                          &#10005;
                        </button>
                      </div>
                    ) : paramEnum ? (
                      <select
                        value={rawValue}
                        onChange={(e) => onSetConfig(key, e.target.value)}
                        className="w-full px-2 py-1 text-xs border rounded font-mono focus:outline-none focus:border-accent/50
                          bg-white/[0.04] border-white/10 text-zinc-200
                          [&>option]:bg-surface-raised [&>option]:text-zinc-200"
                      >
                        <option value="" disabled>
                          {`choose ${key}...`}
                        </option>
                        {paramEnum.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        placeholder={paramTypeLabel}
                        value={rawValue}
                        onChange={(e) => onSetConfig(key, e.target.value)}
                        className="w-full px-2 py-1 text-xs border rounded font-mono focus:outline-none focus:border-accent/50
                          bg-white/[0.04] border-white/10 text-zinc-200 placeholder:text-zinc-700"
                      />
                    )}
                  </div>
                  {/* Right-side action: auto-wire-available badge, or pick-source button */}
                  {!isPilled && autoWire && hasLiteralValue && (
                    <span
                      className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded border text-zinc-600 border-white/5"
                      title={`Auto-wire available: ${autoWire.fromLabel} (overridden by literal)`}
                    >
                      <span className="line-through">{autoWire.fromLabel}</span>
                    </span>
                  )}
                  {!isPilled && (
                    <button
                      onClick={() => setPickingParam(key)}
                      className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded border border-white/10 text-zinc-500 hover:text-accent-bright hover:border-accent/30 transition-colors"
                      title="Pick an upstream field"
                    >
                      pick source
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Output signal chain toggle */}
        {step.toolId && (
          <div className="space-y-2">
            <button
              onClick={() => { setShowOutput(!showOutput); if (showOutput) onSetOutput(null); }}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {showOutput ? "- Hide output chain" : "+ Chain to signal"}
            </button>
            {showOutput && (
              <OutputPicker
                signals={signals}
                selected={step.outputSignalType}
                onSelect={onSetOutput}
              />
            )}
          </div>
        )}

        {/* Preview toggle */}
        {step.toolId && (
          <div>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {showPreview ? "- Hide preview" : "Preview"}
            </button>
            {showPreview && (
              <div className="mt-1.5 pl-2 border-l border-white/5">
                <StepPreview
                  toolId={step.toolId}
                  config={step.config}
                  outputSignalType={step.outputSignalType}
                  toolCatalog={tools}
                  wires={wires}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tool picker modal */}
      {showToolPicker && (
        <ToolPicker
          tools={tools}
          onSelect={onSetTool}
          onClose={() => setShowToolPicker(false)}
        />
      )}

      {/* Field picker modal */}
      {pickingParam && (
        <FieldPicker
          paramName={pickingParam}
          paramType={pickingParamType}
          sources={fieldSources}
          onPick={(template) => onSetConfig(pickingParam, template)}
          onClose={() => setPickingParam(null)}
        />
      )}
    </div>
  );
}
