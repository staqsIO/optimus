"use client";

/**
 * ActionRequiredV2 — grouped action required component for the board.
 * Groups items by type: HITL (always expanded), PRs (collapsed), Failures (collapsed).
 * Replaces the flat urgency-sorted list from ActionRequired.
 */

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useToast } from "@/components/Toast";
import { useEventStream } from "@/hooks/useEventStream";
import { useCurrentUser } from "@/hooks/useCurrentUser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface ActionRequiredV2Props {
  onCountsChange?: (counts: { hitl: number; total: number }) => void;
}

// ---------------------------------------------------------------------------
// Chevron icon
// ---------------------------------------------------------------------------

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Count pill sub-component
// ---------------------------------------------------------------------------

function CountPill({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: "red" | "purple" | "zinc" | "blue";
}) {
  const colorStyles = {
    red: "bg-red-500/15 text-red-400 ring-red-500/20",
    purple: "bg-purple-500/15 text-purple-400 ring-purple-500/20",
    zinc: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/20",
    blue: "bg-blue-500/15 text-blue-400 ring-blue-500/20",
  }[color];

  return (
    <span
      className={`text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-full ring-1 ${colorStyles}`}
    >
      {count} {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ActionGroup sub-component
// ---------------------------------------------------------------------------

function ActionGroup({
  label,
  items,
  defaultExpanded,
  accentColor,
  batchDismiss = false,
  batchDismissLabel,
  onBatchDismiss,
  renderItem,
}: {
  label: string;
  items: ActionItem[];
  defaultExpanded: boolean;
  accentColor: "red" | "purple" | "zinc" | "blue";
  batchDismiss?: boolean;
  batchDismissLabel?: string;
  onBatchDismiss?: () => void;
  renderItem: (item: ActionItem) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Keep HITL group expanded when items exist
  useEffect(() => {
    if (accentColor === "red" && items.length > 0) {
      setExpanded(true);
    }
  }, [accentColor, items.length]);

  return (
    <div className="rounded-lg border border-white/5 overflow-hidden mb-2">
      {/* Group header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-4 py-2.5
                   bg-zinc-900 hover:bg-zinc-800/80 transition-colors text-left"
        aria-expanded={expanded}
      >
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        <div className="flex items-center gap-2">
          {batchDismiss && expanded && onBatchDismiss && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onBatchDismiss();
              }}
              className="text-[10px] text-zinc-500 hover:text-zinc-300
                         px-2 py-0.5 rounded bg-zinc-800 transition-colors"
            >
              {batchDismissLabel}
            </button>
          )}
          <ChevronIcon
            className={`h-3 w-3 text-zinc-600 transition-transform duration-150 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {/* Items */}
      {expanded && (
        <div className="divide-y divide-white/[0.03]">
          {items.map((item) => (
            <div key={`${item.type}-${item.id}`}>{renderItem(item)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ActionRequiredV2({ onCountsChange }: ActionRequiredV2Props) {
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

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 30s
  useEffect(() => {
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  // SSE-driven refresh
  useEventStream("hitl_request", useCallback(() => { load(); }, [load]));
  useEventStream("campaign_update", useCallback(() => { load(); }, [load]));
  useEventStream("state_changed", useCallback(() => { load(); }, [load]));

  // Report counts to parent
  useEffect(() => {
    if (onCountsChange) {
      const hitlCount = items.filter((i) => i.type === "hitl").length;
      onCountsChange({ hitl: hitlCount, total: items.length });
    }
  }, [items, onCountsChange]);

  // --- Action handlers (preserved from ActionRequired) ---

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
    } catch {
      toast.error("Failed to send response");
    }
    setActing(null);
    await load();
  }

  async function handleTriageOverride(item: ActionItem, decision: "auto_assigned" | "skipped") {
    setActing(item.id);
    try {
      await opsPost("/api/triage/override", { id: item.id, decision });
      toast.success(decision === "auto_assigned" ? "Issue assigned" : "Issue skipped");
    } catch {
      toast.error("Failed to update triage");
    }
    setActing(null);
    await load();
  }

  async function handleCampaignRetry(item: ActionItem) {
    setActing(item.id);
    try {
      const campaignId = item.metadata.campaign_id as string;
      await opsPost(`/api/campaigns/${campaignId}/resume`, {});
      toast.success("Campaign resumed — waiting for runner");
    } catch {
      toast.error("Failed to resume campaign");
    }
    setActing(null);
    await load();
  }

  async function handleCampaignCancel(item: ActionItem) {
    setActing(item.id);
    try {
      const campaignId = item.metadata.campaign_id as string;
      await opsPost(`/api/campaigns/${campaignId}/cancel`, {});
      toast.success("Campaign cancelled");
    } catch {
      toast.error("Failed to cancel campaign");
    }
    setActing(null);
    await load();
  }

  async function handleBatchDismissFailures() {
    const failedItems = items.filter((i) => i.type === "failed_campaign");
    for (const item of failedItems) {
      try {
        const campaignId = item.metadata.campaign_id as string;
        await opsPost(`/api/campaigns/${campaignId}/cancel`, {});
      } catch {
        // continue dismissing others
      }
    }
    toast.success(`Dismissed ${failedItems.length} failures`);
    await load();
  }

  // --- Grouping ---

  const hitlItems = items.filter((i) => i.type === "hitl");
  const prItems = items.filter((i) => i.type === "open_pr");
  const failedItems = items.filter((i) => i.type === "failed_campaign");
  const triageItems = items.filter((i) => i.type === "triage_review");
  const total = items.length;

  const counts = {
    hitl: hitlItems.length,
    prs: prItems.length,
    failed: failedItems.length,
    triage: triageItems.length,
  };

  // --- Render item by type ---

  function renderItem(item: ActionItem) {
    const isHitl = item.type === "hitl";
    const isFailed = item.type === "failed_campaign";
    const isExpanded = expandedId === item.id;
    const isActing = acting === item.id;

    return (
      <div
        className={`${
          isHitl
            ? "border-l-2 border-l-red-500 bg-red-500/5"
            : isFailed
              ? "bg-zinc-900/40 opacity-75"
              : "bg-zinc-900"
        }`}
      >
        <div
          className="px-4 py-3 flex items-start gap-3 cursor-pointer"
          onClick={() => setExpandedId(isExpanded ? null : item.id)}
        >
          <div className="flex-1 min-w-0">
            <p
              className={`text-sm truncate ${
                isHitl ? "text-zinc-100 font-medium" : "text-zinc-400"
              }`}
            >
              {item.title}
            </p>
            <p className="text-xs text-zinc-600 mt-0.5 truncate">{item.subtitle}</p>
          </div>

          {/* Inline actions */}
          <div
            className="flex items-center gap-1.5 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {isAdmin && item.type === "triage_review" && (
              <>
                <button
                  onClick={() => handleTriageOverride(item, "auto_assigned")}
                  disabled={isActing}
                  className="text-[11px] px-2.5 py-1 rounded-md transition-colors bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 ring-1 ring-emerald-500/20 disabled:opacity-40"
                >
                  Assign
                </button>
                <button
                  onClick={() => handleTriageOverride(item, "skipped")}
                  disabled={isActing}
                  className="text-[11px] px-2.5 py-1 rounded-md transition-colors bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700 ring-1 ring-white/5 disabled:opacity-40"
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
                  className="text-[11px] px-2.5 py-1 rounded-md transition-colors bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700 ring-1 ring-white/5 disabled:opacity-40"
                >
                  Retry
                </button>
                <button
                  onClick={() => handleCampaignCancel(item)}
                  disabled={isActing}
                  className="text-[11px] px-2.5 py-1 rounded-md transition-colors text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                >
                  Dismiss
                </button>
              </>
            )}

            {item.type === "open_pr" && item.metadata.github_pr_url ? (
              <a
                href={String(item.metadata.github_pr_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] px-2.5 py-1 rounded-md transition-colors bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 ring-1 ring-purple-500/20"
              >
                View on GitHub
              </a>
            ) : null}

            {isAdmin && item.type === "hitl" && (
              <ChevronIcon
                className={`h-3 w-3 text-zinc-500 transition-transform duration-150 ${
                  isExpanded ? "rotate-180" : ""
                }`}
              />
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
                onChange={(e) =>
                  setHitlInput((prev) => ({ ...prev, [item.id]: e.target.value }))
                }
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
            <div className="text-xs text-zinc-400">
              {item.metadata.reasoning as string}
            </div>
            <div className="flex gap-3 mt-2 text-[10px] text-zinc-500">
              {item.metadata.clarity_score && (
                <span>Clarity: {item.metadata.clarity_score as number}/5</span>
              )}
              {item.metadata.classification && (
                <span>Type: {item.metadata.classification as string}</span>
              )}
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
  }

  // --- Loading state ---

  if (loading) {
    return (
      <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
        <div className="h-5 w-40 rounded bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="py-5 text-center text-sm text-zinc-600">No pending actions</div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
            Action Required
          </h2>
          {total > 0 && (
            <span
              className="text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-full
                         bg-red-500/15 text-red-400 ring-1 ring-red-500/20"
            >
              {total}
            </span>
          )}
        </div>

        {/* Type breakdown pills */}
        <div className="flex items-center gap-1.5">
          {counts.hitl > 0 && (
            <CountPill label="Decision" count={counts.hitl} color="red" />
          )}
          {counts.prs > 0 && (
            <CountPill label="PR" count={counts.prs} color="purple" />
          )}
          {counts.failed > 0 && (
            <CountPill label="Failed" count={counts.failed} color="zinc" />
          )}
          {counts.triage > 0 && (
            <CountPill label="Triage" count={counts.triage} color="blue" />
          )}
        </div>
      </div>

      {/* Groups */}
      {hitlItems.length > 0 && (
        <ActionGroup
          label="Decisions Needed"
          items={hitlItems}
          defaultExpanded={true}
          accentColor="red"
          renderItem={renderItem}
        />
      )}

      {prItems.length > 0 && (
        <ActionGroup
          label="Open PRs"
          items={prItems}
          defaultExpanded={false}
          accentColor="purple"
          renderItem={renderItem}
        />
      )}

      {triageItems.length > 0 && (
        <ActionGroup
          label="Triage Review"
          items={triageItems}
          defaultExpanded={false}
          accentColor="blue"
          renderItem={renderItem}
        />
      )}

      {failedItems.length > 0 && (
        <ActionGroup
          label={`${failedItems.length} Failures`}
          items={failedItems}
          defaultExpanded={false}
          accentColor="zinc"
          batchDismiss={true}
          batchDismissLabel="Dismiss all failures"
          onBatchDismiss={handleBatchDismissFailures}
          renderItem={renderItem}
        />
      )}
    </div>
  );
}

/**
 * Lightweight hook for badge count polling.
 * Re-exported for SideNav compatibility.
 */
export { useActionCount } from "@/components/ActionRequired";
