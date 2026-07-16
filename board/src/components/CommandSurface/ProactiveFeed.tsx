"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { opsPost, opsFetch } from "@/lib/ops-api";
import { useEventStream, EventStreamEvent } from "@/hooks/useEventStream";

interface FeedItem {
  id: string;
  type: "hitl" | "draft" | "campaign_complete" | "agent_error" | "agent_toggled";
  title: string;
  detail?: string;
  timestamp: string;
  read: boolean;
  data?: Record<string, unknown>;
}

export default function ProactiveFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [hitlAnswer, setHitlAnswer] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const idCounter = useRef(0);

  const addItem = useCallback((item: Omit<FeedItem, "id" | "timestamp" | "read">) => {
    const id = `feed-${Date.now()}-${idCounter.current++}`;
    setItems((prev) => [{
      ...item,
      id,
      timestamp: new Date().toISOString(),
      read: false,
    }, ...prev].slice(0, 50)); // Keep last 50 items
  }, []);

  // Subscribe to HITL requests
  useEventStream("hitl_request", useCallback((event: EventStreamEvent) => {
    addItem({
      type: "hitl",
      title: "Campaign needs input",
      detail: (event.question as string) || "An agent has a question",
      data: {
        campaignId: event.campaign_id || event.campaignId,
        requestId: event.request_id || event.requestId,
        agentId: event.agent_id || event.agentId,
      },
    });
  }, [addItem]));

  // Subscribe to campaign outcomes
  useEventStream("campaign_outcome_recorded", useCallback((event: EventStreamEvent) => {
    const outcome = (event.outcome as string) || "completed";
    addItem({
      type: "campaign_complete",
      title: `Campaign ${outcome}`,
      detail: (event.title as string) || (event.goal as string) || "",
      data: { campaignId: event.campaign_id || event.campaignId, outcome },
    });
  }, [addItem]));

  // Subscribe to agent toggles
  useEventStream("agent_toggled", useCallback((event: EventStreamEvent) => {
    addItem({
      type: "agent_toggled",
      title: `${event.agentId} ${event.enabled ? "enabled" : "disabled"}`,
    });
  }, [addItem]));

  // Load initial pending HITL requests on mount
  useEffect(() => {
    async function loadPendingHitl() {
      const data = await opsFetch<{ campaigns: Array<{ id: string; goal_description: string; campaign_status: string; work_item_title: string }> }>("/api/campaigns");
      if (data?.campaigns) {
        for (const c of data.campaigns.filter(c => c.campaign_status === "awaiting_input")) {
          addItem({
            type: "hitl",
            title: "Campaign awaiting input",
            detail: c.work_item_title || c.goal_description?.slice(0, 80),
            data: { campaignId: c.id },
          });
        }
      }
    }
    loadPendingHitl();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitHitlResponse(item: FeedItem) {
    const answer = hitlAnswer[item.id]?.trim();
    if (!answer || submitting[item.id]) return;

    const campaignId = item.data?.campaignId;
    const requestId = item.data?.requestId;
    if (!campaignId) return;

    setSubmitting((prev) => ({ ...prev, [item.id]: true }));

    // If we have a specific request ID, respond to it directly
    if (requestId) {
      await opsPost(`/api/campaigns/${campaignId}/hitl/${requestId}/respond`, { answer });
    } else {
      // Get pending request first
      const pending = await opsFetch<{ request: { id: string } }>(`/api/campaigns/${campaignId}/hitl/pending`);
      if (pending?.request?.id) {
        await opsPost(`/api/campaigns/${campaignId}/hitl/${pending.request.id}/respond`, { answer });
      }
    }

    setSubmitting((prev) => ({ ...prev, [item.id]: false }));
    setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, read: true } : i));
  }

  function markRead(id: string) {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, read: true } : i));
  }

  const typeColors: Record<string, string> = {
    hitl: "border-violet-500/30 bg-violet-500/5",
    draft: "border-blue-500/30 bg-blue-500/5",
    campaign_complete: "border-emerald-500/30 bg-emerald-500/5",
    agent_error: "border-red-500/30 bg-red-500/5",
    agent_toggled: "border-zinc-500/30 bg-zinc-500/5",
  };

  const typeIcons: Record<string, string> = {
    hitl: "?",
    draft: "\u2709",
    campaign_complete: "\u2713",
    agent_error: "!",
    agent_toggled: "\u21BB",
  };

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        <div className="text-center">
          <div className="text-2xl mb-2">~</div>
          <div>No notifications yet.</div>
          <div className="text-xs text-zinc-700 mt-1">Events will appear here in real-time.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto space-y-2 p-3">
      {items.map((item) => (
        <div
          key={item.id}
          className={`rounded-lg border p-3 transition-colors ${typeColors[item.type] || "border-zinc-700 bg-zinc-800/50"} ${item.read ? "opacity-60" : ""}`}
        >
          <div className="flex items-start gap-2">
            <span className="text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center bg-zinc-800 text-zinc-400 shrink-0 mt-0.5">
              {typeIcons[item.type] || "\u2022"}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-200">{item.title}</div>
              {item.detail && (
                <div className="text-xs text-zinc-400 mt-0.5 truncate">{item.detail}</div>
              )}
              <div className="text-[10px] text-zinc-600 mt-1">
                {new Date(item.timestamp).toLocaleTimeString()}
              </div>
            </div>
            {!item.read && item.type !== "hitl" && (
              <button
                onClick={() => markRead(item.id)}
                className="text-[10px] text-zinc-600 hover:text-zinc-400 shrink-0"
              >
                dismiss
              </button>
            )}
          </div>

          {/* HITL inline response form */}
          {item.type === "hitl" && !item.read ? (
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={hitlAnswer[item.id] || ""}
                onChange={(e) => setHitlAnswer((prev) => ({ ...prev, [item.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && submitHitlResponse(item)}
                placeholder="Type your answer..."
                className="flex-1 bg-zinc-800 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
              />
              <button
                onClick={() => submitHitlResponse(item)}
                disabled={!!submitting[item.id] || !hitlAnswer[item.id]?.trim()}
                className="px-2 py-1 text-xs bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-white rounded transition-colors"
              >
                {submitting[item.id] ? "..." : "Send"}
              </button>
            </div>
          ) : null}

          {/* Campaign complete: link to detail */}
          {item.type === "campaign_complete" && item.data?.campaignId ? (
            <Link
              href={`/campaigns/${String(item.data.campaignId)}`}
              className="inline-block mt-2 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
              onClick={() => markRead(item.id)}
            >
              View campaign &rarr;
            </Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
