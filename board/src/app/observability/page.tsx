"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { inboxGet, timeAgo } from "@/components/inbox/shared";
import { useCurrentUser } from "@/hooks/useCurrentUser";

// ---------------------------------------------------------------------------
// Observability / Services — surfaces the scheduled-services control plane
// (GET /api/services/status + pause/resume/trigger). STAQPRO-537.
// Read-only status for everyone; mutating controls gated to board admins and
// enforced server-side (POST routes require req.auth.role === 'board').
// ---------------------------------------------------------------------------

type LastStatus = "ok" | "failed" | "running" | "skipped" | null;

interface ScheduledService {
  name: string;
  interval_ms: number;
  delay_ms: number;
  is_critical: boolean;
  is_paused: boolean;
  last_run_at: string | null;
  last_status: LastStatus;
  last_error: string | null;
  last_duration_ms: number | null;
  failure_count: number;
  total_runs: number;
  registered_at: string;
  paused_by: string | null;
  paused_at: string | null;
}

type ServiceAction = "pause" | "resume" | "trigger";

const POLL_INTERVAL_MS = 30_000;

function isServicesPayload(value: unknown): value is { services: ScheduledService[] } {
  if (!value || typeof value !== "object") return false;
  return Array.isArray((value as { services?: unknown }).services);
}

function formatInterval(ms: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---- Status badge ----------------------------------------------------------

function StateBadge({ svc }: { svc: ScheduledService }) {
  if (svc.is_paused) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded font-medium bg-amber-500/20 text-amber-300">
        Paused
      </span>
    );
  }
  const map: Record<string, { bg: string; label: string }> = {
    ok: { bg: "bg-emerald-500/20 text-emerald-300", label: "Running" },
    running: { bg: "bg-blue-500/20 text-blue-300", label: "In progress" },
    failed: { bg: "bg-red-500/20 text-red-300", label: "Failed" },
    skipped: { bg: "bg-zinc-500/20 text-zinc-300", label: "Skipped" },
  };
  const c = svc.last_status ? map[svc.last_status] : null;
  if (!c) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded font-medium bg-zinc-500/20 text-zinc-300">
        Idle
      </span>
    );
  }
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${c.bg}`}>
      {c.label}
    </span>
  );
}

// ---- Per-service action controls -------------------------------------------

function ServiceControls({
  svc,
  isAdmin,
  busy,
  armed,
  onArm,
  onCancel,
  onConfirm,
}: {
  svc: ScheduledService;
  isAdmin: boolean;
  busy: boolean;
  armed: ServiceAction | null;
  onArm: (action: ServiceAction) => void;
  onCancel: () => void;
  onConfirm: (action: ServiceAction) => void;
}) {
  if (!isAdmin) {
    return <span className="text-[11px] text-zinc-600">view only</span>;
  }
  if (svc.is_critical) {
    return (
      <span
        className="text-[11px] text-zinc-500"
        title="Critical services cannot be paused or manually triggered"
      >
        🔒 critical
      </span>
    );
  }

  if (armed) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-[11px] text-zinc-500 capitalize">{armed}?</span>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(armed)}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium bg-emerald-500/30 text-emerald-200 rounded border border-emerald-500/40 hover:bg-emerald-500/40 transition-colors disabled:opacity-40"
        >
          {busy ? "Working…" : `Confirm ${armed}`}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {svc.is_paused ? (
        <button
          onClick={() => onArm("resume")}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded-md border bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25 transition-colors disabled:opacity-40"
        >
          Resume
        </button>
      ) : (
        <button
          onClick={() => onArm("pause")}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded-md border bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25 transition-colors disabled:opacity-40"
        >
          Pause
        </button>
      )}
      <button
        onClick={() => onArm("trigger")}
        disabled={busy || svc.is_paused}
        title={svc.is_paused ? "Resume before triggering" : "Run now"}
        className="px-2.5 py-1 text-xs font-medium rounded-md border bg-zinc-700/40 text-zinc-300 border-white/10 hover:bg-zinc-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Trigger
      </button>
    </div>
  );
}

// ---- Page ------------------------------------------------------------------

export default function ObservabilityPage() {
  const { isAdmin, isLoading: userLoading } = useCurrentUser();

  const [services, setServices] = useState<ScheduledService[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Per-service interaction state
  const [armed, setArmed] = useState<{ name: string; action: ServiceAction } | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);
  const [rowOk, setRowOk] = useState<{ name: string; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await inboxGet("/api/services/status");
      if (!res.ok) {
        setStatusError(true);
      } else {
        const data: unknown = await res.json();
        if (isServicesPayload(data)) {
          setServices([...data.services].sort((a, b) => a.name.localeCompare(b.name)));
          setStatusError(false);
        } else {
          setStatusError(true);
        }
      }
    } catch {
      setStatusError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStatus();
    setRefreshing(false);
  }, [fetchStatus]);

  const runAction = useCallback(
    async (name: string, action: ServiceAction) => {
      setBusyName(name);
      setRowError(null);
      setRowOk(null);
      try {
        const res = await fetch("/api/inbox-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `/api/services/${encodeURIComponent(name)}/${action}` }),
        });
        const d: { error?: string } = await res.json().catch(() => ({}));
        if (!res.ok || d.error) {
          throw new Error(d.error ?? `HTTP ${res.status}`);
        }
        setRowOk({ name, message: `${action} ok` });
        setArmed(null);
        await fetchStatus();
      } catch (err) {
        setRowError({ name, message: err instanceof Error ? err.message : `${action} failed` });
      } finally {
        setBusyName(null);
      }
    },
    [fetchStatus],
  );

  const summary = useMemo(() => {
    const total = services.length;
    const paused = services.filter((s) => s.is_paused).length;
    const failing = services.filter((s) => !s.is_paused && s.last_status === "failed").length;
    return { total, paused, failing };
  }, [services]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Services</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Scheduled background services — status, last run, and operator controls.
          </p>
        </div>
        <button
          onClick={manualRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 text-xs font-medium rounded-md border bg-zinc-700/40 text-zinc-300 border-white/10 hover:bg-zinc-700/60 transition-colors disabled:opacity-40"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Summary band */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">Services</div>
          <div className="text-lg font-bold tabular-nums text-zinc-100">{summary.total}</div>
        </div>
        <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">Paused</div>
          <div className={`text-lg font-bold tabular-nums ${summary.paused > 0 ? "text-amber-300" : "text-zinc-100"}`}>
            {summary.paused}
          </div>
        </div>
        <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">Failing</div>
          <div className={`text-lg font-bold tabular-nums ${summary.failing > 0 ? "text-red-300" : "text-zinc-100"}`}>
            {summary.failing}
          </div>
        </div>
      </div>

      {loading || userLoading ? (
        <div className="px-4 py-3 rounded-lg bg-zinc-800/30 border border-white/5 text-xs text-zinc-500">
          Loading services…
        </div>
      ) : statusError ? (
        <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          Services status unavailable — backend unreachable.
        </div>
      ) : services.length === 0 ? (
        <div className="px-4 py-3 rounded-lg bg-zinc-800/30 border border-white/5 text-xs text-zinc-500">
          No scheduled services registered.
        </div>
      ) : (
        <div className="rounded-lg border border-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-zinc-500 bg-surface-raised">
                <th className="text-left font-medium px-4 py-2.5">Service</th>
                <th className="text-left font-medium px-4 py-2.5">State</th>
                <th className="text-left font-medium px-4 py-2.5">Last run</th>
                <th className="text-left font-medium px-4 py-2.5">Interval</th>
                <th className="text-right font-medium px-4 py-2.5">Controls</th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => {
                const isArmed = armed?.name === svc.name ? armed.action : null;
                const isBusy = busyName === svc.name;
                return (
                  <tr key={svc.name} className="border-t border-white/5 align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-200">{svc.name}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        {svc.total_runs} runs
                        {svc.failure_count > 0 && (
                          <span className="text-red-400"> · {svc.failure_count} failures</span>
                        )}
                        {svc.is_critical && <span className="text-zinc-600"> · critical</span>}
                      </div>
                      {svc.is_paused && svc.paused_by && (
                        <div className="text-[11px] text-amber-400/80 mt-0.5">
                          paused by {svc.paused_by}
                          {svc.paused_at ? ` · ${timeAgo(svc.paused_at)}` : ""}
                        </div>
                      )}
                      {rowError?.name === svc.name && (
                        <div className="text-[11px] text-red-400 mt-1">{rowError.message}</div>
                      )}
                      {rowOk?.name === svc.name && !rowError && (
                        <div className="text-[11px] text-emerald-400 mt-1">{rowOk.message}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StateBadge svc={svc} />
                      {svc.last_status === "failed" && svc.last_error && (
                        <div
                          className="text-[11px] text-red-400/80 mt-1 max-w-[14rem] truncate"
                          title={svc.last_error}
                        >
                          {svc.last_error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">
                      <div>{svc.last_run_at ? timeAgo(svc.last_run_at) : "never"}</div>
                      {svc.last_duration_ms != null && (
                        <div className="text-[11px] text-zinc-600">
                          {formatDuration(svc.last_duration_ms)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{formatInterval(svc.interval_ms)}</td>
                    <td className="px-4 py-3">
                      <ServiceControls
                        svc={svc}
                        isAdmin={isAdmin}
                        busy={isBusy}
                        armed={isArmed}
                        onArm={(action) => {
                          setRowError(null);
                          setRowOk(null);
                          setArmed({ name: svc.name, action });
                        }}
                        onCancel={() => setArmed(null)}
                        onConfirm={(action) => runAction(svc.name, action)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
