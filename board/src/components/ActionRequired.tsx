"use client";

/**
 * ActionRequired — unified pending action items surface for the board.
 * Polls /api/actions/pending every 30s, urgency-sorted flat list.
 * Each item type has inline quick actions.
 */

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useToast } from "@/components/Toast";
import { useEventStream } from "@/hooks/useEventStream";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface ActionItem {
  id: string;
  type: "hitl" | "failed_campaign" | "triage_review" | "open_pr";
  urgency: number;
  title: string;
  subtitle: string;
  metadata: Record<string, string | number | boolean | null>;
  actions: string[];
  created_at: string;
}

interface ActionCounts {
  hitl: number;
  failed: number;
  triage: number;
  prs: number;
  total: number;
}

interface ActionsResponse {
  items: ActionItem[];
  counts: ActionCounts;
}

const TYPE_STYLES: Record<string, string> = {
  hitl: "bg-red-500/20 text-red-300",
  failed_campaign: "bg-orange-500/20 text-orange-300",
  triage_review: "bg-blue-500/20 text-blue-300",
  open_pr: "bg-purple-500/20 text-purple-300",
};

const TYPE_LABELS: Record<string, string> = {
  hitl: "HITL",
  failed_campaign: "Failed",
  triage_review: "Triage",
  open_pr: "PR",
};

export default function ActionRequired() {
  const { isAdmin } = useCurrentUser();
  const toast = useToast();
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hitlInput, setHitlInput] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await opsFetch<ActionsResponse>("/api/actions/pending");
    if (data?.items) {
      setItems(data.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll every 30s
  useEffect(() => {
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  // SSE-driven refresh on relevant events
  useEventStream("hitl_request", useCallback(() => { load(); }, [load]));
  useEventStream("campaign_update", useCallback(() => { load(); }, [load]));
  useEventStream("state_changed", useCallback(() => { load(); }, [load]));

  // HITL respond
  async function handleHitlRespond(item: ActionItem) {
    const answer = hitlInput[item.id]?.trim();
    if (!answer) return;
    setActing(item.id);
    try {
      const campaignId = item.metadata.campaign_id as string;
      await opsPost(`/api/campaigns/${campaignId}/hitl/${item.id}/respond`, { answer });
      setHitlInput((prev) => ({ ...prev, [item.id]: "" }));
      setExpandedId(null);
      toast.success("Response sent — campaign resuming");
    } catch { toast.error("Failed to send response"); }
    setActing(null);
    await load();
  }

  // Triage override
  async function handleTriageOverride(item: ActionItem, decision: "auto_assigned" | "skipped") {
    setActing(item.id);
    try {
      await opsPost("/api/triage/override", { id: item.id, decision });
      toast.success(decision === "auto_assigned" ? "Issue assigned" : "Issue skipped");
    } catch { toast.error("Failed to update triage"); }
    setActing(null);
    await load();
  }

  // Campaign retry
  async function handleCampaignRetry(item: ActionItem) {
    setActing(item.id);
    try {
      const campaignId = item.metadata.campaign_id as string;
      await opsPost(`/api/campaigns/${campaignId}/resume`, {});
      toast.success("Campaign resumed — waiting for runner");
    } catch { toast.error("Failed to resume campaign"); }
    setActing(null);
    await load();
  }

  // Campaign cancel
  async function handleCampaignCancel(item: ActionItem) {
    setActing(item.id);
    try {
      const campaignId = item.metadata.campaign_id as string;
      await opsPost(`/api/campaigns/${campaignId}/cancel`, {});
      toast.success("Campaign cancelled");
    } catch { toast.error("Failed to cancel campaign"); }
    setActing(null);
    await load();
  }

  if (loading) {
    return (
      <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
        <div className="h-5 w-40 rounded bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-300 tracking-wide uppercase">Action Required</h2>
        <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-red-500/20 text-red-300 tabular-nums">
          {items.length}
        </span>
      </div>

      <div className="space-y-1.5">
        {items.map((item) => {
          const isExpanded = expandedId === item.id;
          const isActing = acting === item.id;

          return (
            <div
              key={`${item.type}-${item.id}`}
              className="bg-surface-raised rounded-lg border border-white/5 hover:border-white/10 transition-colors"
            >
              <div
                className="px-4 py-3 flex items-center gap-3 cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
              >
                {/* Type badge */}
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${TYPE_STYLES[item.type] || "bg-zinc-700 text-zinc-400"}`}>
                  {TYPE_LABELS[item.type] || item.type}
                </span>

                {/* Title + subtitle */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate">{item.title}</div>
                  <div className="text-[11px] text-zinc-500">{item.subtitle}</div>
                </div>

                {/* Inline actions for non-expandable types */}
                <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {isAdmin && item.type === "triage_review" && (
                    <>
                      <button
                        onClick={() => handleTriageOverride(item, "auto_assigned")}
                        disabled={isActing}
                        className="px-2 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-300 rounded hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
                      >
                        Assign
                      </button>
                      <button
                        onClick={() => handleTriageOverride(item, "skipped")}
                        disabled={isActing}
                        className="px-2 py-0.5 text-[10px] bg-zinc-700 text-zinc-400 rounded hover:bg-zinc-600 transition-colors disabled:opacity-40"
                      >
                        Skip
                      </button>
                    </>
                  )}

                  {isAdmin && item.type === "failed_campaign" && (
                    <>
                      <button
                        onClick={() => handleCampaignRetry(item)}
                        disabled={isActing}
                        className="px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-40"
                      >
                        Retry
                      </button>
                      <button
                        onClick={() => handleCampaignCancel(item)}
                        disabled={isActing}
                        className="px-2 py-0.5 text-[10px] bg-zinc-700 text-zinc-400 rounded hover:bg-zinc-600 transition-colors disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </>
                  )}

                  {item.type === "open_pr" && item.metadata.github_pr_url ? (
                    <a
                      href={String(item.metadata.github_pr_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-0.5 text-[10px] bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 transition-colors"
                    >
                      View on GitHub
                    </a>
                  ) : null}

                  {isAdmin && item.type === "hitl" && (
                    <svg
                      className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </div>
              </div>

              {/* Expanded HITL input (admin only) */}
              {isAdmin && isExpanded && item.type === "hitl" && (
                <div className="px-4 pb-3 border-t border-white/5 pt-3 space-y-2">
                  <div className="text-xs text-zinc-400">
                    {(item.metadata.question as string) || "Agent needs your input"}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={hitlInput[item.id] || ""}
                      onChange={(e) => setHitlInput((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleHitlRespond(item);
                      }}
                      placeholder="Type your response..."
                      className="flex-1 px-3 py-1.5 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent/40"
                    />
                    <button
                      onClick={() => handleHitlRespond(item)}
                      disabled={isActing || !hitlInput[item.id]?.trim()}
                      className="px-3 py-1.5 text-xs bg-accent/20 text-accent-bright rounded-lg hover:bg-accent/30 transition-colors disabled:opacity-40"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              )}

              {/* Expanded triage details */}
              {isExpanded && item.type === "triage_review" && item.metadata.reasoning && (
                <div className="px-4 pb-3 border-t border-white/5 pt-3">
                  <div className="text-xs text-zinc-500 mb-1">Triage reasoning</div>
                  <div className="text-xs text-zinc-400">{item.metadata.reasoning as string}</div>
                  <div className="flex gap-3 mt-2 text-[10px] text-zinc-500">
                    {item.metadata.clarity_score && <span>Clarity: {item.metadata.clarity_score as number}/5</span>}
                    {item.metadata.classification && <span>Type: {item.metadata.classification as string}</span>}
                    {item.metadata.source_issue_url && (
                      <a
                        href={item.metadata.source_issue_url as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-bright hover:underline"
                      >
                        View issue
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Lightweight hook for badge count polling.
 * Use in SideNav for the Today badge.
 */
export function useActionCount(): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    const data = await opsFetch<{ counts: ActionCounts }>("/api/actions/count");
    if (data?.counts) setCount(data.counts.total);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return count;
}
