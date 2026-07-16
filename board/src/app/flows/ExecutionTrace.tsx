"use client";

import { useState, useEffect } from "react";
import { opsFetch } from "@/lib/ops-api";

interface StepDetail {
  id: string;
  step_index: number;
  tool_id: string;
  dispatch_mode: string;
  status: string;
  input_payload: Record<string, unknown>;
  output_payload: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

interface ExecutionDetail {
  id: string;
  flow_definition_id: string;
  flow_name: string;
  status: string;
  depth: number;
  dry_run: boolean;
  parent_execution_id: string | null;
  trigger_signal: Record<string, unknown> | null;
  final_output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  steps: StepDetail[];
}

const STATUS_BADGE: Record<string, string> = {
  running:   "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed:    "bg-red-500/20 text-red-400 border-red-500/30",
  timed_out: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pending:   "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  skipped:   "bg-zinc-500/20 text-zinc-500 border-zinc-500/30",
};

function Badge({ status }: { status: string }) {
  const cls = STATUS_BADGE[status] ?? STATUS_BADGE.pending;
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${cls}`}>
      {status}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function JsonBlock({ data, label }: { data: unknown; label: string }) {
  const [open, setOpen] = useState(false);
  if (data == null || (typeof data === "object" && Object.keys(data as object).length === 0)) return null;
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-[10px] text-zinc-500 hover:text-zinc-300 font-mono transition-colors"
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <pre className="mt-1 text-[11px] text-zinc-500 bg-black/30 rounded p-2 overflow-x-auto max-h-64 overflow-y-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function ExecutionTrace({
  executionId,
  onClose,
}: {
  executionId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ExecutionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    opsFetch<ExecutionDetail>(`/api/flows/executions/${executionId}`).then((d) => {
      if (!cancelled) {
        setData(d);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [executionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-3xl max-h-[80vh] overflow-y-auto bg-zinc-900 border border-white/10 rounded-lg shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 bg-zinc-900 border-b border-white/10 px-5 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-zinc-100">Execution Trace</span>
            {data && <Badge status={data.status} />}
            {data?.dry_run && (
              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded border bg-blue-500/20 text-blue-400 border-blue-500/30">
                dry_run
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 transition-colors text-lg leading-none">
            &times;
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">Loading trace...</div>
        ) : !data ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">Execution not found</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Metadata grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-zinc-500 block">Flow</span>
                <span className="text-zinc-200 font-mono">{data.flow_name || data.flow_definition_id?.slice(0, 8)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block">Depth</span>
                <span className="text-zinc-200 font-mono">{data.depth}</span>
              </div>
              <div>
                <span className="text-zinc-500 block">Duration</span>
                <span className="text-zinc-200 font-mono">{formatDuration(data.duration_ms)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block">Started</span>
                <span className="text-zinc-200 font-mono">
                  {new Date(data.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
            </div>

            {/* Parent link */}
            {data.parent_execution_id && (
              <div className="text-xs text-zinc-500">
                Parent execution:{" "}
                <span className="text-violet-400 font-mono">{data.parent_execution_id.slice(0, 12)}...</span>
              </div>
            )}

            {/* Error */}
            {data.error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 font-mono">
                {data.error}
              </div>
            )}

            {/* Trigger signal */}
            <JsonBlock data={data.trigger_signal} label="trigger signal" />

            {/* Steps */}
            <div>
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
                Steps ({data.steps?.length ?? 0})
              </span>
              <div className="mt-2 space-y-1">
                {(data.steps ?? []).map((step, i) => (
                  <StepRow key={step.id || i} step={step} />
                ))}
                {(!data.steps || data.steps.length === 0) && (
                  <div className="text-xs text-zinc-600">No steps recorded</div>
                )}
              </div>
            </div>

            {/* Final output */}
            <JsonBlock data={data.final_output} label="final output" />
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({ step }: { step: StepDetail }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-white/5 rounded">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.03] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-zinc-600 text-[10px] font-mono w-5 text-right shrink-0">
          {step.step_index}
        </span>
        <Badge status={step.status} />
        <span className="text-xs text-zinc-200 font-mono truncate flex-1">{step.tool_id}</span>
        <span className="text-[10px] text-zinc-600 font-mono">{step.dispatch_mode}</span>
        <span className="text-[10px] text-zinc-600 font-mono w-16 text-right">
          {formatDuration(step.duration_ms)}
        </span>
        <span className="text-zinc-600 text-xs">{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-1 border-t border-white/5">
          {step.error && (
            <div className="text-xs text-red-400 bg-red-500/10 rounded p-2 font-mono mt-2">
              {step.error}
            </div>
          )}
          <JsonBlock data={step.input_payload} label="input" />
          <JsonBlock data={step.output_payload} label="output" />
        </div>
      )}
    </div>
  );
}
