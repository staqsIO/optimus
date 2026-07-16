"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";

interface DeadManSwitchStatus {
  status: "active" | "overdue" | "standby" | "shutdown" | "not_configured";
  lastRenewal: string | null;
  renewalIntervalDays: number;
  consecutiveMissed: number;
  daysSinceRenewal: number;
}

interface ProxyResponse {
  status?: DeadManSwitchStatus;
  result?: { renewed: boolean; previousStatus: string; daysSinceLastRenewal: number };
  error?: string;
}

const WARN_DAYS = 25;
const DANGER_DAYS = 28;

function isStatusPayload(value: unknown): value is { status: DeadManSwitchStatus } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === "object" && v.status !== null;
}

export default function DeadManSwitchControl() {
  const { data: session } = useSession();
  const [info, setInfo] = useState<DeadManSwitchStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);

  const renewedBy = session?.user?.email ?? session?.user?.name ?? null;

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox-proxy?path=/api/phase/dead-man-switch");
      if (!res.ok) {
        setStatusError(true);
      } else {
        const data: unknown = await res.json();
        if (isStatusPayload(data)) {
          setInfo(data.status);
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
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const executeRenew = useCallback(async () => {
    if (!renewedBy) {
      setError("Sign in required to renew dead-man switch");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/phase/dead-man-switch/renew",
          body: { renewedBy },
        }),
      });
      const d: ProxyResponse = await res.json().catch(() => ({}));
      if (!res.ok || d.error) {
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      await fetchStatus();
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Renewal failed");
    } finally {
      setSubmitting(false);
    }
  }, [renewedBy, fetchStatus]);

  if (loading) {
    return (
      <div className="px-4 py-3 rounded-lg bg-zinc-800/30 border border-white/5 text-xs text-zinc-500">
        Loading dead-man switch...
      </div>
    );
  }

  if (statusError || !info) {
    return (
      <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
        Dead-man switch status unavailable — backend unreachable.
      </div>
    );
  }

  const days = info.daysSinceRenewal;
  const isShutdown = info.status === "shutdown";
  const isStandby = info.status === "standby";
  const isOverdue = info.status === "overdue" || days >= info.renewalIntervalDays;
  const isDanger = isShutdown || isStandby || isOverdue || days >= DANGER_DAYS;
  const isWarn = !isDanger && days >= WARN_DAYS;

  const tone = isDanger
    ? "bg-red-500/10 border-red-500/30"
    : isWarn
      ? "bg-amber-500/10 border-amber-500/30"
      : "bg-zinc-800/30 border-white/5";
  const dot = isDanger
    ? "bg-red-400 animate-pulse"
    : isWarn
      ? "bg-amber-400"
      : "bg-emerald-400";

  const headline = isShutdown
    ? "Dead-man switch SHUTDOWN"
    : isStandby
      ? "Dead-man switch STANDBY"
      : isOverdue
        ? "Dead-man switch OVERDUE"
        : "Dead-man switch active";

  const subline = `${days.toFixed(1)} days since last renewal · ${info.renewalIntervalDays}-day interval${
    info.consecutiveMissed > 0 ? ` · ${info.consecutiveMissed} missed` : ""
  }`;

  return (
    <div className={`px-4 py-3 rounded-lg border space-y-3 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-200">{headline}</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">{subline}</div>
          </div>
        </div>

        {!confirming && (
          <button
            onClick={() => setConfirming(true)}
            disabled={!renewedBy}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
              isDanger
                ? "bg-red-500/20 text-red-300 border-red-500/30 hover:bg-red-500/30"
                : isWarn
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/30 hover:bg-amber-500/30"
                  : "bg-zinc-700/40 text-zinc-300 border-white/10 hover:bg-zinc-700/60"
            }`}
          >
            Renew
          </button>
        )}
      </div>

      {confirming && (
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
          <span className="text-[11px] text-zinc-500 mr-auto">
            Renew as <span className="text-zinc-300">{renewedBy ?? "unknown"}</span>?
          </span>
          <button
            onClick={() => { setConfirming(false); setError(null); }}
            className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={executeRenew}
            disabled={submitting || !renewedBy}
            className="px-3 py-1 text-xs font-medium bg-emerald-500/30 text-emerald-200 rounded border border-emerald-500/40 hover:bg-emerald-500/40 transition-colors disabled:opacity-40"
          >
            {submitting ? "Renewing..." : "Confirm renew"}
          </button>
        </div>
      )}

      {error && (
        <div className="text-[11px] text-red-400 pt-1">{error}</div>
      )}
    </div>
  );
}
