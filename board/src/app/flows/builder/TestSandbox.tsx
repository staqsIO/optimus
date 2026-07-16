"use client";

import { useState } from "react";
import { opsPost, opsFetch } from "@/lib/ops-api";
import { SAMPLE_PAYLOADS } from "./intent-labels";

const STATUS_BADGE: Record<string, string> = {
  running:   "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed:    "bg-red-500/20 text-red-400 border-red-500/30",
  timed_out: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  skipped:   "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

interface StepResult {
  id: string;
  step_index: number;
  tool_id: string;
  dispatch_mode: string;
  status: string;
  input_payload: unknown;
  output_payload: unknown;
  error: string | null;
  duration_ms: number | null;
}

interface RunResult {
  flow_id: string;
  signal_id: string;
  dry_run: boolean;
  execution_count: number;
  results: Array<{
    executionId: string;
    status: string;
    error?: string;
  }>;
}

export default function TestSandbox({
  flowId,
  triggerSignalType,
}: {
  flowId: string;
  triggerSignalType: string;
}) {
  const sample = SAMPLE_PAYLOADS[triggerSignalType] ?? { example: "value" };
  const [payload, setPayload] = useState(JSON.stringify(sample, null, 2));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function runTest() {
    setRunning(true);
    setResult(null);
    setSteps([]);
    setError(null);

    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        setError("Invalid JSON payload");
        setRunning(false);
        return;
      }

      const res = await opsPost<RunResult>(`/api/flows/${flowId}/run?dry_run=true`, {
        payload: parsed,
      });

      if (!res.ok) {
        setError(res.error ?? "Failed to run test");
        setRunning(false);
        return;
      }

      const data = res.data;
      setResult(data);

      // Fetch execution trace for first result
      if (data.results?.[0]?.executionId) {
        const trace = await opsFetch<{ execution: unknown; steps: StepResult[] }>(
          `/api/flows/executions/${data.results[0].executionId}`,
        );
        if (trace?.steps) setSteps(trace.steps);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Payload editor */}
      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
          Sample Payload ({triggerSignalType})
        </label>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full px-3 py-2 text-xs font-mono bg-white/[0.04] border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none"
        />
      </div>

      {/* Run button */}
      <button
        onClick={runTest}
        disabled={running}
        className={`px-4 py-1.5 rounded text-xs font-medium transition-colors
          ${running
            ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
            : "bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30"
          }`}
      >
        {running ? "Running dry test..." : "Run Dry Test"}
      </button>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 border border-red-500/20 rounded-lg p-2 bg-red-500/5">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="border border-white/10 rounded-lg bg-white/[0.02] p-3 space-y-3">
          <div className="flex items-center gap-3 text-xs">
            <span className="inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border bg-blue-500/20 text-blue-400 border-blue-500/30">
              dry run
            </span>
            <span className="text-zinc-400">
              {result.execution_count} execution{result.execution_count !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Step trace */}
          {steps.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest">Step Trace</div>
              {steps.map((s) => (
                <div key={s.id} className="border border-white/5 rounded p-2 space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-zinc-600 w-4 text-right">{s.step_index}.</span>
                    <span className="text-zinc-300">{s.tool_id}</span>
                    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${STATUS_BADGE[s.status] ?? STATUS_BADGE.skipped}`}>
                      {s.status}
                    </span>
                    <span className="text-[10px] text-zinc-600 font-mono">{s.dispatch_mode}</span>
                    {s.duration_ms != null && (
                      <span className="text-[10px] text-zinc-600 ml-auto">{s.duration_ms}ms</span>
                    )}
                  </div>
                  {s.error && (
                    <div className="text-[10px] text-red-400 pl-6">{s.error}</div>
                  )}
                  {s.output_payload != null && (
                    <details className="pl-6">
                      <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400">
                        output
                      </summary>
                      <pre className="text-[10px] text-zinc-500 font-mono mt-1 overflow-x-auto max-h-32">
                        {JSON.stringify(s.output_payload, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
