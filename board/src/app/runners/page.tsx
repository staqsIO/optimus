"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";

interface Runner {
  runner_id: string;
  agents: string[];
  machines: string[] | null;
  latest_heartbeat: string;
  any_processing: boolean;
  agent_count: number;
  seconds_since_heartbeat: number;
  latest_invocation: string | null;
  invocations_1h: number;
  in_progress_count: number;
}

interface RunnersResponse {
  runners?: Runner[];
  error?: string;
}

interface Invocation {
  id: string;
  agent_id: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  latency_ms: number | null;
  created_at: string;
  provider: string | null;
}

interface ActivityResponse {
  runnerId?: string;
  invocations?: Invocation[];
  error?: string;
}

interface RestartResponse {
  command?: { id: string; runner_id: string; issued_by: string; issued_at: string };
  status?: "queued" | "already_pending";
  error?: string;
}

const STALE_AFTER_S = 60;
const DEAD_AFTER_S = 5 * 60;

function formatRel(ts: string | null): string {
  if (!ts) return "—";
  const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function tone(seconds: number): { dot: string; label: string; row: string } {
  if (seconds < STALE_AFTER_S) {
    return { dot: "bg-emerald-400", label: "Live", row: "bg-zinc-800/30 border-white/5" };
  }
  if (seconds < DEAD_AFTER_S) {
    return { dot: "bg-amber-400", label: "Stale", row: "bg-amber-500/5 border-amber-500/20" };
  }
  return { dot: "bg-red-400 animate-pulse", label: "Dead", row: "bg-red-500/5 border-red-500/20" };
}

export default function RunnersPage() {
  const { data: session, status } = useSession();
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, Invocation[]>>({});
  const [confirmingRestart, setConfirmingRestart] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [restartMessage, setRestartMessage] = useState<Record<string, string>>({});

  const issuedBy = session?.user?.email ?? session?.user?.name ?? null;

  const fetchRunners = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox-proxy?path=/api/runners");
      const d: RunnersResponse = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setRunners(d.runners ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runners");
    } finally {
      setLoading(false);
    }
  }, []);

  const restartRunner = useCallback(async (runnerId: string) => {
    if (!issuedBy) {
      setRestartMessage((prev) => ({ ...prev, [runnerId]: "Sign in required" }));
      return;
    }
    setRestarting(runnerId);
    try {
      const path = `/api/runners/${encodeURIComponent(runnerId)}/restart`;
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, body: { issuedBy } }),
      });
      const d: RestartResponse = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      const note = d.status === "already_pending"
        ? "Already pending — will respawn next poll"
        : "Queued — runner will exit + respawn within ~10s";
      setRestartMessage((prev) => ({ ...prev, [runnerId]: note }));
    } catch (err) {
      setRestartMessage((prev) => ({
        ...prev,
        [runnerId]: err instanceof Error ? err.message : "Restart failed",
      }));
    } finally {
      setRestarting(null);
      setConfirmingRestart(null);
    }
  }, [issuedBy]);

  const fetchActivity = useCallback(async (runnerId: string) => {
    try {
      const path = `/api/runners/${encodeURIComponent(runnerId)}/activity`;
      const res = await fetch(`/api/inbox-proxy?path=${encodeURIComponent(path)}`);
      const d: ActivityResponse = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setActivity((prev) => ({ ...prev, [runnerId]: d.invocations ?? [] }));
    } catch (err) {
      setActivity((prev) => ({ ...prev, [runnerId]: [] }));
      console.error("Failed to load runner activity", err);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    fetchRunners();
    const interval = setInterval(fetchRunners, 30_000);
    return () => clearInterval(interval);
  }, [session, fetchRunners]);

  const toggle = (runnerId: string) => {
    if (expanded === runnerId) {
      setExpanded(null);
    } else {
      setExpanded(runnerId);
      if (!activity[runnerId]) fetchActivity(runnerId);
    }
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="text-zinc-500 text-sm">Loading...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="text-zinc-500 text-sm">Sign in to view runners</span>
      </div>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Runners</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Live view of every host running agent loops — Railway primary, M1 satellite, future runners.
        </p>
      </div>

      {loading && !runners && (
        <div className="px-4 py-8 rounded-lg bg-zinc-800/30 border border-white/5 text-xs text-zinc-500 text-center">
          Loading runner heartbeats…
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          {error}
        </div>
      )}

      {runners && runners.length === 0 && !loading && (
        <div className="px-4 py-8 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-amber-300 text-center">
          No heartbeats in the last 24 hours — every runner is dark.
        </div>
      )}

      {runners && runners.length > 0 && (
        <div className="space-y-3">
          {runners.map((r) => {
            const t = tone(r.seconds_since_heartbeat);
            const isOpen = expanded === r.runner_id;
            const acts = activity[r.runner_id];
            return (
              <div
                key={r.runner_id}
                className={`rounded-lg border ${t.row} transition-colors`}
              >
                <button
                  onClick={() => toggle(r.runner_id)}
                  className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${t.dot}`} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-200 truncate">
                        {r.runner_id}
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-zinc-500">
                          {t.label}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5 truncate">
                        {r.agent_count} agent{r.agent_count === 1 ? "" : "s"}
                        {r.machines && r.machines.length > 0 && ` · ${r.machines.join(", ")}`}
                        {" · "}heartbeat {formatRel(r.latest_heartbeat)}
                        {r.any_processing && (
                          <span className="ml-2 text-emerald-400">● processing</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <div className="text-xs text-zinc-300">{r.invocations_1h} /h</div>
                      <div className="text-[10px] text-zinc-500">LLM calls 1h</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-zinc-300">{r.in_progress_count}</div>
                      <div className="text-[10px] text-zinc-500">in-flight</div>
                    </div>
                    <span className="text-zinc-500 text-xs">{isOpen ? "▾" : "▸"}</span>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 pb-3 border-t border-white/5 pt-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                        Controls
                      </div>
                      <div className="flex items-center gap-2">
                        {restartMessage[r.runner_id] && (
                          <span className="text-[11px] text-zinc-400 mr-1">
                            {restartMessage[r.runner_id]}
                          </span>
                        )}
                        {confirmingRestart === r.runner_id ? (
                          <>
                            <button
                              onClick={() => setConfirmingRestart(null)}
                              className="px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => restartRunner(r.runner_id)}
                              disabled={restarting === r.runner_id || !issuedBy}
                              className="px-2.5 py-1 text-[11px] font-medium bg-amber-500/30 text-amber-200 rounded border border-amber-500/40 hover:bg-amber-500/40 transition-colors disabled:opacity-40"
                            >
                              {restarting === r.runner_id ? "Issuing..." : "Confirm restart"}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmingRestart(r.runner_id)}
                            disabled={!issuedBy}
                            className="px-2.5 py-1 text-[11px] font-medium bg-amber-500/20 text-amber-300 rounded border border-amber-500/30 hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title={!issuedBy ? "Sign in required" : `Restart ${r.runner_id}`}
                          >
                            Restart
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">
                        Agents on this runner
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {r.agents.map((a) => (
                          <span
                            key={a}
                            className="px-2 py-0.5 text-[11px] rounded bg-zinc-800/60 text-zinc-300 border border-white/5"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">
                        Recent LLM activity (last 20)
                      </div>
                      {!acts && (
                        <div className="text-[11px] text-zinc-500 italic">Loading…</div>
                      )}
                      {acts && acts.length === 0 && (
                        <div className="text-[11px] text-zinc-500 italic">
                          No invocations yet from agents on this runner.
                        </div>
                      )}
                      {acts && acts.length > 0 && (
                        <div className="text-[11px] font-mono space-y-0.5 max-h-72 overflow-y-auto">
                          {acts.map((inv) => (
                            <div
                              key={inv.id}
                              className="grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 text-zinc-400"
                            >
                              <span className="text-zinc-500">{formatRel(inv.created_at)}</span>
                              <span className="text-zinc-300">{inv.agent_id}</span>
                              <span className="text-zinc-500 truncate">{inv.model}</span>
                              <span>{inv.latency_ms ? `${inv.latency_ms}ms` : "—"}</span>
                              <span>{inv.cost_usd ? `$${Number(inv.cost_usd).toFixed(4)}` : "—"}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[10px] text-zinc-600 pt-4 border-t border-white/5">
        Phase 1: read-only. Restart / pause / agent reassignment controls land in
        STAQPRO-290 Phase 2 once M1 is wrapped in launchd (STAQPRO-291).
      </div>
    </main>
  );
}
