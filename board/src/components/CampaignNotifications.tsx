"use client";

/**
 * Campaign failure/pause notifications.
 *
 * Listens for campaign_failed and campaign_paused SSE events.
 * Shows a persistent banner with failure details and action buttons.
 * "Discuss" button pre-fills chat with campaign context.
 *
 * Delphi: persistent banner (not toast — toasts auto-dismiss),
 * with role="alert" for accessibility.
 */

import { useState, useEffect, useCallback } from "react";
import { useEventStream } from "@/hooks/useEventStream";
import { useChatSession } from "@/contexts/ChatSessionContext";

interface CampaignAlert {
  id: string;
  campaignId: string;
  reason: string;
  status: string;
  goal?: string;
  iterations?: string;
  spent?: string;
  lastIteration?: {
    iteration_number: number;
    quality_score: number | null;
    decision: string;
    failure_analysis: string | null;
    strategy_adjustment: string | null;
  };
  timestamp: number;
}

export default function CampaignNotifications() {
  const [alerts, setAlerts] = useState<CampaignAlert[]>([]);
  const { setActiveSessionId } = useChatSession();

  // Listen for campaign failure/pause events via SSE
  useEffect(() => {
    let eventSource: EventSource | null = null;

    try {
      // Use dedicated SSE proxy route (avoids JSON proxy 502s for event streams)
      eventSource = new EventSource("/api/ops/events");

      eventSource.addEventListener("campaign_failed", (e) => {
        try {
          const data = JSON.parse(e.data);
          const meta = data.metadata || data;
          addAlert({
            campaignId: meta.campaign_id,
            reason: meta.reason || "unknown",
            status: meta.status || "failed",
            goal: meta.goal,
            iterations: meta.iterations,
            spent: meta.spent,
            lastIteration: meta.last_iteration,
          });
        } catch { /* malformed event */ }
      });

      eventSource.addEventListener("campaign_paused", (e) => {
        try {
          const data = JSON.parse(e.data);
          const meta = data.metadata || data;
          addAlert({
            campaignId: meta.campaign_id,
            reason: meta.reason || "paused",
            status: meta.status || "paused",
            goal: meta.goal,
            iterations: meta.iterations,
            spent: meta.spent,
            lastIteration: meta.last_iteration,
          });
        } catch { /* malformed event */ }
      });
      eventSource.addEventListener("campaign_completed", (e) => {
        try {
          const data = JSON.parse(e.data);
          const meta = data.metadata || data;
          addAlert({
            campaignId: meta.campaign_id,
            reason: meta.reason || "completed",
            status: "succeeded",
            goal: meta.goal,
            iterations: meta.iterations,
            spent: meta.spent,
            lastIteration: meta.last_iteration,
          });
        } catch { /* malformed event */ }
      });
    } catch { /* SSE not available */ }

    return () => eventSource?.close();
  }, []);

  // Also try browser notifications when tab is unfocused
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  function addAlert(partial: Omit<CampaignAlert, "id" | "timestamp">) {
    const alert: CampaignAlert = {
      ...partial,
      id: `${partial.campaignId}-${Date.now()}`,
      timestamp: Date.now(),
    };
    setAlerts((prev) => [alert, ...prev.slice(0, 4)]); // Keep max 5

    // Auto-dismiss success notifications after 8s
    if (partial.status === "succeeded") {
      setTimeout(() => dismiss(alert.id), 8000);
    }

    // Browser notification if tab is unfocused
    if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Campaign " + (partial.status === "failed" ? "Failed" : "Paused"), {
        body: partial.goal || partial.reason,
        icon: "/favicon.ico",
      });
    }
  }

  const dismiss = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleDiscuss = useCallback((alert: CampaignAlert) => {
    // Clear current session to start fresh, then navigate to chat
    setActiveSessionId(null);
    // Pre-fill will happen via PageContext when they navigate to campaign
    dismiss(alert.id);
  }, [setActiveSessionId, dismiss]);

  if (alerts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-50 space-y-2 max-w-[400px]" role="alert" aria-live="assertive">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`rounded-lg border p-3 shadow-xl backdrop-blur-sm ${
            alert.status === "succeeded"
              ? "bg-emerald-950/90 border-emerald-500/30"
              : alert.status === "failed"
              ? "bg-red-950/90 border-red-500/30"
              : "bg-amber-950/90 border-amber-500/30"
          }`}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                alert.status === "succeeded" ? "bg-emerald-500/20 text-emerald-300" :
                alert.status === "failed" ? "bg-red-500/20 text-red-300" : "bg-amber-500/20 text-amber-300"
              }`}>
                {alert.status}
              </span>
              <span className="text-xs text-zinc-300 font-medium">Campaign</span>
            </div>
            <button
              onClick={() => dismiss(alert.id)}
              className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
              aria-label="Dismiss"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Goal */}
          {alert.goal && (
            <p className="text-xs text-zinc-300 mb-2 line-clamp-2">{alert.goal}</p>
          )}

          {/* Failure details */}
          <div className="text-[10px] text-zinc-500 space-y-0.5 mb-2">
            <div>Reason: <span className="text-zinc-400">{alert.reason.replace(/_/g, " ")}</span></div>
            {alert.iterations && <div>Iterations: <span className="text-zinc-400">{alert.iterations}</span></div>}
            {alert.lastIteration?.failure_analysis && (
              <div>Analysis: <span className="text-zinc-400">{alert.lastIteration.failure_analysis.slice(0, 120)}</span></div>
            )}
            {alert.lastIteration?.strategy_adjustment && (
              <div>Suggestion: <span className="text-zinc-400">{alert.lastIteration.strategy_adjustment.slice(0, 120)}</span></div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <a
              href={`/campaigns`}
              className="px-2 py-1 text-[10px] bg-white/5 text-zinc-300 rounded hover:bg-white/10 transition-colors"
            >
              {alert.status === "succeeded" ? "View Preview" : "View Details"}
            </a>
            {alert.status !== "succeeded" && (
              <button
                onClick={() => handleDiscuss(alert)}
                className={`px-2 py-1 text-[10px] rounded transition-colors ${
                  alert.status === "failed"
                    ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                    : "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                }`}
              >
                Discuss
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
