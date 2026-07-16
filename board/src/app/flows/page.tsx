"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { opsFetch, opsPost, opsPatch, opsDelete } from "@/lib/ops-api";
import { formatDuration, formatTime, formatDate } from "@/lib/format";
import ExecutionTrace from "./ExecutionTrace";

const FlowsMonitor = dynamic(() => import("./FlowsMonitor"), { ssr: false });
const FlowBuilder = dynamic(() => import("./FlowBuilder"), { ssr: false });

/* ───────── Types ───────── */

interface FlowDefinition {
  id: string;
  name: string;
  version: number;
  trigger_signal_type: string;
  steps: unknown[];
  is_active: boolean;
  max_depth: number;
  timeout_ms: number;
  created_at: string;
}

interface FlowExecution {
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

/* ───────── DAG Validation ───────── */

interface FlowStep {
  tool_id: string;
  depends_on?: string[];
  [key: string]: unknown;
}

function validateDAG(steps: FlowStep[]): string | null {
  const ids = new Set(steps.map((_, i) => String(i)));
  // Build adjacency from depends_on (indices as strings)
  const adj = new Map<string, string[]>();
  for (let i = 0; i < steps.length; i++) {
    const deps = steps[i].depends_on ?? [];
    for (const dep of deps) {
      const d = String(dep);
      if (!ids.has(d)) return `Step ${i} depends on non-existent step ${d}`;
      if (!adj.has(d)) adj.set(d, []);
      adj.get(d)!.push(String(i));
    }
  }
  // Topological sort cycle detection (Kahn's algorithm)
  const inDeg = new Map<string, number>();
  for (const id of ids) inDeg.set(id, 0);
  for (const [, targets] of adj) {
    for (const t of targets) inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }
  const queue = [...ids].filter((id) => inDeg.get(id) === 0);
  let visited = 0;
  let front = 0;
  while (front < queue.length) {
    const node = queue[front++];
    visited++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (visited < ids.size) return "Steps contain a dependency cycle";
  return null;
}

/* ───────── New Flow Modal (JSON editor) ───────── */

function NewFlowModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [triggerSignalType, setTriggerSignalType] = useState("");
  const [stepsJson, setStepsJson] = useState("[]");
  const [maxDepth, setMaxDepth] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    if (!triggerSignalType.trim()) { setError("Trigger signal type is required"); return; }

    let steps: FlowStep[];
    try {
      steps = JSON.parse(stepsJson);
      if (!Array.isArray(steps)) { setError("Steps must be a JSON array"); return; }
    } catch {
      setError("Invalid JSON in steps"); return;
    }

    const cycleErr = validateDAG(steps);
    if (cycleErr) { setError(cycleErr); return; }

    setSubmitting(true);
    const res = await opsPost("/api/flows", {
      name: name.trim(),
      trigger_signal_type: triggerSignalType.trim(),
      steps,
      max_depth: maxDepth,
      timeout_ms: timeoutMs,
    });
    setSubmitting(false);

    if (!res.ok) { setError(res.error); return; }
    onCreated();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-lg p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-200">New Flow Definition</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Trigger Signal Type</label>
            <input value={triggerSignalType} onChange={(e) => setTriggerSignalType(e.target.value)}
              placeholder="e.g. email.received, signal.briefing"
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Steps (JSON array)</label>
            <textarea value={stepsJson} onChange={(e) => setStepsJson(e.target.value)} rows={6}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-zinc-500 mb-1">Max Depth</label>
              <input type="number" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))}
                className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-zinc-500 mb-1">Timeout (ms)</label>
              <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
            </div>
          </div>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting}
            className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors">
            {submitting ? "Creating..." : "Create Flow"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Run Flow Modal ───────── */

function RunFlowModal({ flow, onClose, onRun }: { flow: FlowDefinition; onClose: () => void; onRun: () => void }) {
  const [payloadJson, setPayloadJson] = useState("{}");
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSubmit() {
    setError(null);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      setError("Invalid JSON payload"); return;
    }

    setSubmitting(true);
    const res = await opsPost(`/api/flows/${flow.id}/run`, { payload, dry_run: dryRun });
    setSubmitting(false);

    if (!res.ok) { setError(res.error); return; }
    onRun();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-lg p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-200">Run Flow: <span className="text-cyan-400">{flow.name}</span></h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Payload (JSON)</label>
            <textarea value={payloadJson} onChange={(e) => setPayloadJson(e.target.value)} rows={6}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600" />
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)}
              className="rounded border-white/10" />
            Dry run (simulate without executing)
          </label>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting}
            className="text-xs px-3 py-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors">
            {submitting ? "Running..." : dryRun ? "Dry Run" : "Run Flow"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Edit Flow Modal (raw JSON view + edit) ───────── */

function EditFlowModal({ flow, onClose, onSaved }: { flow: FlowDefinition; onClose: () => void; onSaved: () => void }) {
  // The full definition rendered as editable raw JSON — "paste into Claude to
  // fix" friendly. Steps + trigger are immutable on an existing row (the backend
  // models flows as versioned); changing them supersedes the flow with a NEW
  // version and deactivates this one. Metadata-only edits PATCH in place.
  const [json, setJson] = useState(() =>
    JSON.stringify(
      {
        name: flow.name,
        trigger_signal_type: flow.trigger_signal_type,
        steps: flow.steps ?? [],
        max_depth: flow.max_depth,
        timeout_ms: flow.timeout_ms,
        is_active: flow.is_active,
      },
      null,
      2,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSave() {
    setError(null);
    let parsed: {
      name?: string;
      trigger_signal_type?: string;
      steps?: FlowStep[];
      max_depth?: number;
      timeout_ms?: number;
      is_active?: boolean;
    };
    try {
      parsed = JSON.parse(json);
    } catch {
      setError("Invalid JSON"); return;
    }
    if (!parsed.name?.trim()) { setError("Name is required"); return; }
    if (!parsed.trigger_signal_type?.trim()) { setError("Trigger signal type is required"); return; }
    if (!Array.isArray(parsed.steps)) { setError("Steps must be a JSON array"); return; }

    const cycleErr = validateDAG(parsed.steps);
    if (cycleErr) { setError(cycleErr); return; }

    const stepsChanged = JSON.stringify(parsed.steps) !== JSON.stringify(flow.steps ?? []);
    const triggerChanged = parsed.trigger_signal_type.trim() !== flow.trigger_signal_type;

    setSubmitting(true);

    // Steps/trigger changed → create a superseding version, then deactivate the old.
    if (stepsChanged || triggerChanged) {
      const created = await opsPost("/api/flows", {
        name: parsed.name.trim(),
        trigger_signal_type: parsed.trigger_signal_type.trim(),
        steps: parsed.steps,
        max_depth: parsed.max_depth ?? flow.max_depth,
        timeout_ms: parsed.timeout_ms ?? flow.timeout_ms,
      });
      if (!created.ok) { setSubmitting(false); setError(created.error); return; }
      const del = await opsDelete(`/api/flows/${flow.id}`);
      setSubmitting(false);
      if (!del.ok) { setError(`New version created, but deactivating the old one failed: ${del.error}`); return; }
      onSaved();
      onClose();
      return;
    }

    // Metadata-only → PATCH in place.
    const res = await opsPatch(`/api/flows/${flow.id}`, {
      name: parsed.name.trim(),
      max_depth: parsed.max_depth ?? flow.max_depth,
      timeout_ms: parsed.timeout_ms ?? flow.timeout_ms,
      is_active: parsed.is_active ?? flow.is_active,
    });
    setSubmitting(false);
    if (!res.ok) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setNotice("Copied");
    } catch {
      setNotice("Copy failed");
    }
    setTimeout(() => setNotice(null), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">Edit Flow: <span className="text-cyan-400">{flow.name}</span></h3>
          <span className="text-[10px] font-mono text-zinc-600">v{flow.version}</span>
          <button onClick={copyJson} className="ml-auto text-xs px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200 border border-white/10 transition-colors">
            {notice ?? "Copy JSON"}
          </button>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">Definition (raw JSON)</label>
          <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={16} spellCheck={false}
            className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-600" />
          <p className="text-[10px] text-zinc-600 mt-1">
            Editing <span className="text-zinc-400">steps</span> or <span className="text-zinc-400">trigger_signal_type</span> creates a new version and deactivates this one. Other fields update in place.
          </p>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={submitting}
            className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors">
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Legacy Monitor (from main) ───────── */

function LegacyFlowsMonitor() {
  const [definitions, setDefinitions] = useState<FlowDefinition[]>([]);
  const [executions, setExecutions] = useState<FlowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedExecId, setSelectedExecId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [showNewFlow, setShowNewFlow] = useState(false);
  const [runFlow, setRunFlow] = useState<FlowDefinition | null>(null);
  const [editFlow, setEditFlow] = useState<FlowDefinition | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const flowsRes = await opsFetch<{ flows: FlowDefinition[] }>("/api/flows");

      if (flowsRes?.flows) {
        setDefinitions(flowsRes.flows);

        // Cap detail fetches to 10 flows to avoid N+1 polling overhead on the 5s interval.
        // TODO: Add a batch /api/flows/executions/recent endpoint to eliminate N+1.
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
              // Enrich with flow name without mutating the response object
              const enrichedExec = (!exec.flow_name && detail.flow)
                ? { ...exec, flow_name: detail.flow.name }
                : exec;
              allExecs.push(enrichedExec);
            }
          }
        }
        // Sort by started_at descending
        allExecs.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
        setExecutions(allExecs);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDelete = useCallback(async (def: FlowDefinition) => {
    if (!window.confirm(`Delete flow "${def.name}"? This deactivates it (soft delete).`)) return;
    const res = await opsDelete(`/api/flows/${def.id}`);
    if (!res.ok) { window.alert(`Delete failed: ${res.error}`); return; }
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Live polling
  useEffect(() => {
    if (liveMode) {
      intervalRef.current = setInterval(fetchData, 5000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [liveMode, fetchData]);

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Flows (Legacy)</span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setShowNewFlow(true)}
            className="text-xs px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
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
                        <th className="text-center px-3 py-2 font-medium"></th>
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
                          <td className="px-3 py-2 text-center">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                onClick={() => setRunFlow(def)}
                                className="text-xs px-2 py-0.5 rounded bg-cyan-600/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-600/30 transition-colors"
                              >
                                Run
                              </button>
                              <button
                                onClick={() => setEditFlow(def)}
                                className="text-xs px-2 py-0.5 rounded bg-zinc-600/20 text-zinc-300 border border-zinc-500/30 hover:bg-zinc-600/30 transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(def)}
                                className="text-xs px-2 py-0.5 rounded bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
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

      {/* New Flow modal */}
      {showNewFlow && (
        <NewFlowModal
          onClose={() => setShowNewFlow(false)}
          onCreated={() => { setLoading(true); fetchData(); }}
        />
      )}

      {/* Run Flow modal */}
      {runFlow && (
        <RunFlowModal
          flow={runFlow}
          onClose={() => setRunFlow(null)}
          onRun={() => { setLoading(true); fetchData(); }}
        />
      )}

      {/* Edit Flow modal */}
      {editFlow && (
        <EditFlowModal
          flow={editFlow}
          onClose={() => setEditFlow(null)}
          onSaved={() => { setLoading(true); fetchData(); }}
        />
      )}
    </>
  );
}

/* ───────── Tabs ───────── */

const TABS = [
  { key: "monitor", label: "Monitor" },
  { key: "builder", label: "Builder" },
  { key: "legacy",  label: "Legacy" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/* ───────── Page ───────── */

function FlowsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get("tab") as TabKey | null;
  const [activeTab, setActiveTab] = useState<TabKey>(
    tabParam && TABS.some((t) => t.key === tabParam) ? tabParam : "monitor",
  );

  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    router.replace(`/flows?tab=${tab}`, { scroll: false });
  }

  return (
    <div className="flex flex-col h-[calc(100vh-49px)] bg-zinc-950 text-zinc-100">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-2 border-b border-white/10 shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => switchTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors
              ${activeTab === tab.key
                ? "text-zinc-100 bg-white/[0.06] border-b-2 border-accent"
                : "text-zinc-500 hover:text-zinc-300"
              }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "monitor" && (
        <FlowsMonitor onNewFlow={() => switchTab("builder")} />
      )}
      {activeTab === "builder" && (
        <FlowBuilder onDone={() => switchTab("monitor")} />
      )}
      {activeTab === "legacy" && <LegacyFlowsMonitor />}
    </div>
  );
}

export default function FlowsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-49px)] bg-zinc-950 text-sm text-zinc-500">Loading flows...</div>}>
      <FlowsPageInner />
    </Suspense>
  );
}
