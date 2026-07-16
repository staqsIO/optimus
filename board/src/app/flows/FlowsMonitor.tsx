"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { opsFetch } from "@/lib/ops-api";
import ExecutionTrace from "./ExecutionTrace";
import type { FlowDefinition, FlowExecution } from "./builder/types";

/* ───────── Helpers ───────── */

const STATUS_BADGE: Record<string, string> = {
  running:   "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed:    "bg-red-500/20 text-red-400 border-red-500/30",
  timed_out: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pending:   "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* ───────── Monitor ───────── */

export default function FlowsMonitor({ onNewFlow }: { onNewFlow: () => void }) {
  const [definitions, setDefinitions] = useState<FlowDefinition[]>([]);
  const [executions, setExecutions] = useState<FlowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedExecId, setSelectedExecId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    const flowsRes = await opsFetch<{ flows: FlowDefinition[] }>("/api/flows");

    if (flowsRes?.flows) {
      setDefinitions(flowsRes.flows);

      const flowsToFetch = flowsRes.flows.slice(0, 10);
      const detailResults = await Promise.all(
        flowsToFetch.map((f) =>
          opsFetch<{ flow: FlowDefinition; executions: FlowExecution[] }>(`/api/flows/${f.id}`)
        ),
      );

      const allExecs: FlowExecution[] = [];
      for (const detail of detailResults) {
        if (detail?.executions) {
          for (const exec of detail.executions) {
            if (!exec.flow_name && detail.flow) {
              exec.flow_name = detail.flow.name;
            }
            allExecs.push(exec);
          }
        }
      }
      allExecs.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
      setExecutions(allExecs);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (liveMode) {
      intervalRef.current = setInterval(fetchData, 5000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [liveMode, fetchData]);

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Flows</span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={onNewFlow}
            className="text-xs px-2.5 py-1 rounded bg-accent/20 text-accent-bright hover:bg-accent/30 transition-colors"
          >
            + New Flow
          </button>
          <button
            onClick={() => { setLoading(true); fetchData(); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            refresh
          </button>
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded transition-colors
              ${liveMode ? "text-emerald-400 bg-emerald-500/10" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
            live
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">Loading flows...</div>
        ) : (
          <>
            {/* ── Flow Definitions ── */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
                Flow Definitions ({definitions.length})
              </h2>
              {definitions.length === 0 ? (
                <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
                  No flow definitions registered
                </div>
              ) : (
                <div className="border border-white/5 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/5 text-zinc-500">
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Trigger</th>
                        <th className="text-center px-3 py-2 font-medium">Ver</th>
                        <th className="text-center px-3 py-2 font-medium">Steps</th>
                        <th className="text-center px-3 py-2 font-medium">Max Depth</th>
                        <th className="text-center px-3 py-2 font-medium">Timeout</th>
                        <th className="text-center px-3 py-2 font-medium">Status</th>
                        <th className="text-right px-3 py-2 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {definitions.map((def) => (
                        <tr key={def.id} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                          <td className="px-3 py-2 text-zinc-200">{def.name}</td>
                          <td className="px-3 py-2 text-cyan-400">{def.trigger_signal_type}</td>
                          <td className="px-3 py-2 text-center text-zinc-400">v{def.version}</td>
                          <td className="px-3 py-2 text-center text-zinc-400">{def.steps?.length ?? 0}</td>
                          <td className="px-3 py-2 text-center text-zinc-400">{def.max_depth}</td>
                          <td className="px-3 py-2 text-center text-zinc-500">{formatDuration(def.timeout_ms)}</td>
                          <td className="px-3 py-2 text-center">
                            {def.is_active ? (
                              <span className="text-emerald-400">active</span>
                            ) : (
                              <span className="text-zinc-600">inactive</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-500">{formatDate(def.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ── Recent Executions ── */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
                Recent Executions ({executions.length})
              </h2>
              {executions.length === 0 ? (
                <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
                  No executions yet
                </div>
              ) : (
                <div className="border border-white/5 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/5 text-zinc-500">
                        <th className="text-left px-3 py-2 font-medium">Flow</th>
                        <th className="text-center px-3 py-2 font-medium">Status</th>
                        <th className="text-center px-3 py-2 font-medium">Depth</th>
                        <th className="text-center px-3 py-2 font-medium">Dry Run</th>
                        <th className="text-right px-3 py-2 font-medium">Duration</th>
                        <th className="text-right px-3 py-2 font-medium">Started</th>
                        <th className="text-center px-3 py-2 font-medium">Chain</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {executions.map((exec) => (
                        <tr
                          key={exec.id}
                          onClick={() => setSelectedExecId(exec.id)}
                          className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                        >
                          <td className="px-3 py-2 text-zinc-200">{exec.flow_name || exec.flow_definition_id?.slice(0, 12)}</td>
                          <td className="px-3 py-2 text-center"><Badge status={exec.status} /></td>
                          <td className="px-3 py-2 text-center text-zinc-400">{exec.depth}</td>
                          <td className="px-3 py-2 text-center">
                            {exec.dry_run ? (
                              <span className="text-blue-400">yes</span>
                            ) : (
                              <span className="text-zinc-600">no</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-400">{formatDuration(exec.duration_ms)}</td>
                          <td className="px-3 py-2 text-right text-zinc-500">{formatTime(exec.started_at)}</td>
                          <td className="px-3 py-2 text-center">
                            {exec.parent_execution_id ? (
                              <span className="text-violet-400" title={`Parent: ${exec.parent_execution_id}`}>
                                chained
                              </span>
                            ) : (
                              <span className="text-zinc-700">root</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-white/5 flex items-center gap-4 text-xs text-zinc-700 shrink-0">
        <span>{definitions.length} flows</span>
        <span>{executions.length} executions</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" /> running
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> completed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> failed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500" /> timed_out
        </span>
      </div>

      {/* Execution trace modal */}
      {selectedExecId && (
        <ExecutionTrace
          executionId={selectedExecId}
          onClose={() => setSelectedExecId(null)}
        />
      )}
    </>
  );
}
