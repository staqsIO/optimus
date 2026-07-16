"use client";

import { useMemo } from "react";
import { fieldCompatibility, getToolLabel } from "./intent-labels";
import type { Compatibility } from "./intent-labels";

export interface FieldSource {
  from: "trigger" | `step${number}`;
  label: string;            // "trigger", "step 1 — Fetch email content"
  fields: Record<string, string>;  // { fieldName: type }
}

interface CandidateField {
  name: string;
  type: string;
  compat: Compatibility;
}

export default function FieldPicker({
  paramName,
  paramType,
  sources,
  onPick,
  onClose,
}: {
  paramName: string;
  paramType: string | undefined;
  sources: FieldSource[];
  onPick: (template: string) => void;
  onClose: () => void;
}) {
  // Filter + group by source, dropping any source whose fields are all hidden
  const groups = useMemo(() => {
    const out: { source: FieldSource; fields: CandidateField[] }[] = [];
    for (const src of sources) {
      const fields: CandidateField[] = Object.entries(src.fields)
        .map(([name, type]) => ({ name, type, compat: fieldCompatibility(paramType, type) }))
        .filter((f) => f.compat !== "hidden");
      if (fields.length > 0) out.push({ source: src, fields });
    }
    return out;
  }, [sources, paramType]);

  const totalFields = groups.reduce((n, g) => n + g.fields.length, 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-zinc-950/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface-raised border border-white/10 rounded-xl shadow-2xl flex flex-col max-h-[70vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">Wire input</div>
            <div className="text-sm text-zinc-200 font-mono truncate">
              {paramName}
              {paramType ? <span className="text-zinc-600"> : {paramType}</span> : null}
            </div>
          </div>
          <button onClick={onClose} className="text-xs text-zinc-600 hover:text-zinc-300">esc</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {totalFields === 0 ? (
            <div className="text-xs text-zinc-600 text-center py-8">
              No compatible upstream fields for <span className="font-mono">{paramName}</span>.
            </div>
          ) : (
            groups.map(({ source, fields }) => (
              <div key={source.from}>
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-1.5">
                  {source.label}
                </div>
                <div className="space-y-1">
                  {fields.map((f) => (
                    <button
                      key={`${source.from}.${f.name}`}
                      onClick={() => {
                        onPick(`{{${source.from}.${f.name}}}`);
                        onClose();
                      }}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded border border-white/5 hover:border-accent/30 hover:bg-white/[0.03] transition-colors"
                    >
                      <span className="flex-1 text-xs font-mono text-zinc-200 truncate">{f.name}</span>
                      <span className="shrink-0 text-[10px] font-mono text-zinc-500">{f.type || "?"}</span>
                      {f.compat === "warn" && (
                        <span
                          className="shrink-0 text-[10px] text-amber-400/80"
                          title={
                            !f.type
                              ? "Upstream field has no declared type"
                              : `May not be ${paramType ?? "compatible"}`
                          }
                        >
                          &#9888;
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-white/5 text-[10px] text-zinc-600">
          Selecting writes <span className="font-mono text-zinc-500">{`{{source.field}}`}</span> into this input.
        </div>
      </div>
    </div>
  );
}

/**
 * Build the list of sources visible to a step's picker:
 * trigger first (if we have a schema), then each prior step's output schema.
 * Hidden behind a helper so StepEditor doesn't reimplement the label format.
 */
export function buildFieldSources(
  triggerSchema: Record<string, string> | undefined,
  previousStepOutputs: { stepIndex: number; toolId: string; outputSchema: Record<string, string> }[],
): FieldSource[] {
  const out: FieldSource[] = [];
  if (triggerSchema && Object.keys(triggerSchema).length > 0) {
    out.push({ from: "trigger", label: "trigger", fields: triggerSchema });
  }
  for (const step of previousStepOutputs) {
    out.push({
      from: `step${step.stepIndex + 1}` as FieldSource["from"],
      label: `step ${step.stepIndex + 1} — ${getToolLabel(step.toolId)}`,
      fields: step.outputSchema ?? {},
    });
  }
  return out;
}
