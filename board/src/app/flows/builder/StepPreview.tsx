"use client";

import type { ToolCatalogEntry } from "./types";
import type { WireSource } from "./intent-labels";
import { getToolLabel, getSignalLabel } from "./intent-labels";

export default function StepPreview({
  toolId,
  config,
  outputSignalType,
  toolCatalog,
  wires,
}: {
  toolId: string | null;
  config: Record<string, string>;
  outputSignalType: string | null;
  toolCatalog: ToolCatalogEntry[];
  wires?: Record<string, WireSource | undefined>;
}) {
  if (!toolId) {
    return <div className="text-[10px] text-zinc-600 italic">Select a tool to see preview</div>;
  }

  const tool = toolCatalog.find((t) => t.tool_id === toolId);
  const label = getToolLabel(toolId);
  const mode = tool?.dispatch_mode ?? "function";
  const params = tool?.parameters ?? {};

  // Build summary of how each parameter gets its value
  const paramSources = Object.keys(params).map((key) => {
    const manualValue = config[key];
    const wire = wires?.[key];
    if (manualValue) return { key, source: `"${manualValue}"`, type: "manual" as const };
    if (wire) return { key, source: wire.fromLabel, type: "wired" as const };
    return { key, source: "not set", type: "missing" as const };
  });

  return (
    <div className="text-[10px] text-zinc-500 space-y-1.5">
      <div>
        <span className="text-zinc-400">Action:</span>{" "}
        <span className="text-zinc-300">{label}</span>
        {mode === "agent" && <span className="text-violet-400 ml-1">(routes to agent)</span>}
        {mode === "hybrid" && <span className="text-blue-400 ml-1">(hybrid: function + agent fallback)</span>}
      </div>

      {paramSources.length > 0 && (
        <div className="space-y-0.5">
          <span className="text-zinc-400">Parameters:</span>
          {paramSources.map((p) => (
            <div key={p.key} className="pl-3 font-mono flex items-center gap-1.5">
              <span className="text-zinc-500">{p.key}</span>
              <span className="text-zinc-700">&larr;</span>
              <span className={
                p.type === "wired" ? "text-emerald-400" :
                p.type === "manual" ? "text-zinc-300" :
                "text-amber-500/60"
              }>
                {p.source}
              </span>
            </div>
          ))}
        </div>
      )}

      {outputSignalType && (
        <div>
          <span className="text-zinc-400">Then emits:</span>{" "}
          <span className="text-cyan-400">{getSignalLabel(outputSignalType)}</span>
          <span className="text-zinc-600 ml-1">({outputSignalType})</span>
        </div>
      )}
    </div>
  );
}
