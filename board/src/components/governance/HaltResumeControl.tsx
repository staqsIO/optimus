"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Emergency halt/resume control for the governance page.
 * Parity with CLI `halt` / `resume` commands — fail-closed.
 */
export default function HaltResumeControl() {
  const [halted, setHalted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<"halt" | "resume" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox-proxy?path=/api/halt-status");
      if (res.ok) {
        const d = await res.json();
        setHalted(Boolean(d?.halted));
        setStatusError(false);
      } else {
        setStatusError(true);
      }
    } catch {
      setStatusError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const executeHalt = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/halt",
          body: { reason: reason.trim() || "Board halt via governance page" },
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await fetchStatus();
      setConfirming(null);
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Halt failed");
    } finally {
      setSubmitting(false);
    }
  }, [reason, fetchStatus]);

  const executeResume = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/resume", body: {} }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await fetchStatus();
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setSubmitting(false);
    }
  }, [fetchStatus]);

  if (loading) {
    return (
      <div className="px-4 py-3 rounded-lg bg-zinc-800/30 border border-white/5 text-xs text-zinc-500">
        Loading halt status...
      </div>
    );
  }

  return (
    <div
      className={`px-4 py-3 rounded-lg border space-y-3 ${
        halted
          ? "bg-red-500/10 border-red-500/30"
          : statusError
            ? "bg-amber-500/10 border-amber-500/30"
            : "bg-zinc-800/30 border-white/5"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${
              halted
                ? "bg-red-400 animate-pulse"
                : statusError
                  ? "bg-amber-400 animate-pulse"
                  : "bg-emerald-400"
            }`}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-200">
              {halted
                ? "System HALTED"
                : statusError
                  ? "Halt status unavailable"
                  : "System running"}
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              {halted
                ? "All agents are blocked from processing new tasks."
                : statusError
                  ? "Halt status unavailable \u2014 backend unreachable."
                  : "All agents processing tasks normally."}
            </div>
          </div>
        </div>

        {!confirming && (
          halted ? (
            <button
              onClick={() => setConfirming("resume")}
              className="px-3 py-1.5 text-xs font-medium bg-emerald-500/20 text-emerald-300 rounded-md border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors shrink-0"
            >
              Resume
            </button>
          ) : (
            <button
              onClick={() => setConfirming("halt")}
              className="px-3 py-1.5 text-xs font-medium bg-red-500/20 text-red-300 rounded-md border border-red-500/30 hover:bg-red-500/30 transition-colors shrink-0"
            >
              Emergency Halt
            </button>
          )
        )}
      </div>

      {confirming === "halt" && (
        <div className="space-y-2 pt-2 border-t border-white/5">
          <label className="block text-[11px] text-zinc-500">
            Reason (optional)
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Investigating runaway cost"
            maxLength={500}
            className="w-full px-3 py-1.5 text-xs bg-zinc-900 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-red-500/50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => { setConfirming(null); setReason(""); setError(null); }}
              className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={executeHalt}
              disabled={submitting}
              className="px-3 py-1 text-xs font-medium bg-red-500/30 text-red-200 rounded border border-red-500/40 hover:bg-red-500/40 transition-colors disabled:opacity-40"
            >
              {submitting ? "Halting..." : "Confirm halt"}
            </button>
          </div>
        </div>
      )}

      {confirming === "resume" && (
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
          <span className="text-[11px] text-zinc-500 mr-auto">
            Resume task processing?
          </span>
          <button
            onClick={() => { setConfirming(null); setError(null); }}
            className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={executeResume}
            disabled={submitting}
            className="px-3 py-1 text-xs font-medium bg-emerald-500/30 text-emerald-200 rounded border border-emerald-500/40 hover:bg-emerald-500/40 transition-colors disabled:opacity-40"
          >
            {submitting ? "Resuming..." : "Confirm resume"}
          </button>
        </div>
      )}

      {error && (
        <div className="text-[11px] text-red-400 pt-1">{error}</div>
      )}
    </div>
  );
}
