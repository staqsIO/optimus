"use client";

/**
 * ServicesTab -- shows all scheduled services with status, timing, and controls.
 * Lives as a tab in the Agent Hub.
 */

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface Service {
  name: string;
  interval_ms: number;
  delay_ms: number;
  is_critical: boolean;
  is_paused: boolean;
  last_run_at: string | null;
  last_status: "ok" | "failed" | "running" | "skipped" | null;
  last_error: string | null;
  last_duration_ms: number | null;
  failure_count: number;
  total_runs: number;
  registered_at: string;
  paused_by: string | null;
  paused_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  ok: "bg-emerald-500",
  failed: "bg-red-500",
  running: "bg-blue-500 animate-pulse",
  skipped: "bg-zinc-500",
};

function humanInterval(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "--";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function ServicesTab() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await opsFetch<{ services: Service[] }>("/api/services/status");
    setServices(data?.services || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  async function handlePause(name: string) {
    setActing(name);
    await opsPost(`/api/services/${name}/pause`);
    setActing(null);
    await load();
  }

  async function handleResume(name: string) {
    setActing(name);
    await opsPost(`/api/services/${name}/resume`);
    setActing(null);
    await load();
  }

  async function handleTrigger(name: string) {
    setActing(name);
    await opsPost(`/api/services/${name}/trigger`);
    setActing(null);
    // Brief delay so status updates
    setTimeout(load, 1000);
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-zinc-500">Loading services...</div>;
  }

  const criticalCount = services.filter(s => s.is_critical).length;
  const failedCount = services.filter(s => s.last_status === "failed").length;
  const pausedCount = services.filter(s => s.is_paused).length;

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-1">Total Services</div>
          <div className="text-lg font-bold text-zinc-200">{services.length}</div>
        </div>
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-1">Critical</div>
          <div className="text-lg font-bold text-amber-300">{criticalCount}</div>
        </div>
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-1">Failed</div>
          <div className="text-lg font-bold text-red-400">{failedCount}</div>
        </div>
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-1">Paused</div>
          <div className="text-lg font-bold text-zinc-400">{pausedCount}</div>
        </div>
      </div>

      {/* Services table */}
      <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-xs text-zinc-500 uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Interval</th>
                <th className="text-center px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Last Run</th>
                <th className="text-right px-4 py-3 font-medium">Duration</th>
                <th className="text-right px-4 py-3 font-medium">Failures</th>
                <th className="text-right px-4 py-3 font-medium">Total Runs</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {services.map((svc) => (
                <tr
                  key={svc.name}
                  className={`hover:bg-white/[0.02] transition-colors ${svc.is_paused ? "opacity-50" : ""}`}
                >
                  {/* Name with critical badge */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-200">{svc.name}</span>
                      {svc.is_critical && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/20"
                          title="Critical -- cannot be paused or triggered from dashboard"
                        >
                          critical
                        </span>
                      )}
                      {svc.is_paused && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-700 text-zinc-400">
                          paused
                        </span>
                      )}
                    </div>
                    {svc.last_error && svc.last_status === "failed" && (
                      <div className="text-[10px] text-red-400 mt-0.5 truncate max-w-[300px]" title={svc.last_error}>
                        {svc.last_error}
                      </div>
                    )}
                  </td>

                  {/* Interval */}
                  <td className="px-4 py-3 text-zinc-400 text-xs">
                    {humanInterval(svc.interval_ms)}
                  </td>

                  {/* Status dot */}
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full ${
                        svc.last_status ? STATUS_COLORS[svc.last_status] || "bg-zinc-600" : "bg-zinc-700"
                      }`}
                      title={svc.last_status || "never run"}
                    />
                  </td>

                  {/* Last Run */}
                  <td className="px-4 py-3 text-zinc-400 text-xs">
                    {relativeTime(svc.last_run_at)}
                  </td>

                  {/* Duration */}
                  <td className="px-4 py-3 text-right text-zinc-400 text-xs">
                    {svc.last_duration_ms != null
                      ? svc.last_duration_ms < 1000
                        ? `${svc.last_duration_ms}ms`
                        : `${(svc.last_duration_ms / 1000).toFixed(1)}s`
                      : "--"}
                  </td>

                  {/* Failures */}
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs ${svc.failure_count > 0 ? "text-red-400 font-medium" : "text-zinc-500"}`}>
                      {svc.failure_count}
                    </span>
                  </td>

                  {/* Total Runs */}
                  <td className="px-4 py-3 text-right text-zinc-500 text-xs">
                    {svc.total_runs}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* Pause/Resume toggle */}
                      {svc.is_paused ? (
                        <button
                          onClick={() => handleResume(svc.name)}
                          disabled={acting === svc.name || svc.is_critical}
                          className="px-2 py-1 text-xs bg-emerald-600/20 text-emerald-300 rounded hover:bg-emerald-600/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          title={svc.is_critical ? "Cannot resume critical service from dashboard" : "Resume service"}
                        >
                          Resume
                        </button>
                      ) : (
                        <button
                          onClick={() => handlePause(svc.name)}
                          disabled={acting === svc.name || svc.is_critical}
                          className="px-2 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          title={svc.is_critical ? "Cannot pause critical service" : "Pause service"}
                        >
                          Pause
                        </button>
                      )}

                      {/* Run Now */}
                      <button
                        onClick={() => handleTrigger(svc.name)}
                        disabled={acting === svc.name || svc.is_critical || svc.is_paused}
                        className="px-2 py-1 text-xs bg-blue-600/20 text-blue-300 rounded hover:bg-blue-600/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={
                          svc.is_critical
                            ? "Cannot trigger critical service"
                            : svc.is_paused
                            ? "Resume service first"
                            : "Run now"
                        }
                      >
                        Run Now
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {services.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-zinc-600 text-sm">
                    No services registered. Start the agent runtime to populate.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
