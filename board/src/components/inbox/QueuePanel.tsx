"use client";

import { useState } from "react";
import QueueItem, { type Draft, type PipelineStats, TRIAGE_COLORS } from "./QueueItem";

// STAQPRO-552: summary of why the pending list may be empty (responder tier opt-in
// gate skips, plus auto-archive of created drafts). Returned by GET /api/drafts.
export interface PipelineSummary {
  producedLast7d: number;
  pending: number;
  autoArchivedLast7d: number;
  rejectedLast7d: number;
  responderSkippedLast7d: number;
}

// ---------------------------------------------------------------------------
// QueuePanel — Left column container
// ---------------------------------------------------------------------------

export default function QueuePanel({
  drafts,
  stats,
  selectedDraftId,
  selectedDrafts,
  focusIndex,
  filterCategory,
  onFilterCategory,
  filterVerdict,
  onFilterVerdict,
  onSelectDraft,
  onToggleSelect,
  onBulkApproveReady,
  loading,
  pipelineSummary,
}: {
  drafts: Draft[];
  stats: PipelineStats | null;
  pipelineSummary?: PipelineSummary | null;
  selectedDraftId: string | null;
  selectedDrafts: Set<string>;
  focusIndex: number;
  filterCategory: string | null;
  onFilterCategory: (cat: string | null) => void;
  filterVerdict: string | null;
  onFilterVerdict: (v: string | null) => void;
  onSelectDraft: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onBulkApproveReady: () => void;
  loading: boolean;
}) {
  // Group drafts by confidence tier
  const highConfidence = drafts.filter((d) => d.confidence_tier === "high");
  const needsReview = drafts.filter((d) => d.confidence_tier !== "high");

  // Triage category counts (from unfiltered set via parent)
  const triageCounts: Record<string, number> = {};
  for (const d of drafts) {
    const cat = d.emails.triage_category || "pending";
    triageCounts[cat] = (triageCounts[cat] || 0) + 1;
  }

  // Verdict counts
  const verdictCounts: Record<string, number> = {};
  for (const d of drafts) {
    verdictCounts[d.reviewer_verdict] = (verdictCounts[d.reviewer_verdict] || 0) + 1;
  }

  // Build the ordered flat list matching parent's filteredDrafts order
  const orderedDrafts = [...highConfidence, ...needsReview];

  return (
    <div className="w-80 shrink-0 flex flex-col h-full border-r border-white/5 max-md:w-full max-md:border-r-0">
      {/* Queue Header */}
      <div className="px-4 py-3 border-b border-white/5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-100">Drafts</h2>
            <span className="text-xs tabular-nums bg-surface-overlay text-zinc-400 px-1.5 py-0.5 rounded-full">
              {drafts.length}
            </span>
          </div>
        </div>

        {/* Pipeline stats strip */}
        {stats && (
          <div className="flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="tabular-nums">
              {stats.emails_received_today} received
            </span>
            <span className="text-zinc-700">/</span>
            <span className="tabular-nums">
              ${parseFloat(stats.cost_today_usd || "0").toFixed(2)} cost
            </span>
            <span className="text-zinc-700">/</span>
            <span className="tabular-nums">
              {stats.edit_rate_14d_pct ?? "--"}% edit
            </span>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-1.5 flex-wrap overflow-x-auto">
        {/* Triage category pills */}
        {Object.entries(triageCounts).map(([cat, count]) => (
          <button
            key={cat}
            onClick={() => onFilterCategory(filterCategory === cat ? null : cat)}
            className={`text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset transition-colors whitespace-nowrap ${
              filterCategory === cat
                ? TRIAGE_COLORS[cat] || TRIAGE_COLORS.pending
                : "text-zinc-500 ring-white/5 hover:ring-white/10 hover:text-zinc-400"
            }`}
          >
            {cat.replace("_", " ")} {count}
          </button>
        ))}

        {/* Divider */}
        {Object.keys(verdictCounts).length > 0 && (
          <div className="h-3 w-px bg-white/10 mx-0.5" />
        )}

        {/* Verdict pills */}
        {Object.entries(verdictCounts).map(([verdict, count]) => {
          const vColors: Record<string, string> = {
            approved: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
            flagged: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
            rejected: "bg-red-500/10 text-red-400 ring-red-500/20",
          };
          return (
            <button
              key={verdict}
              onClick={() => onFilterVerdict(filterVerdict === verdict ? null : verdict)}
              className={`text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset transition-colors whitespace-nowrap ${
                filterVerdict === verdict
                  ? vColors[verdict] || "text-zinc-400 ring-white/10"
                  : "text-zinc-500 ring-white/5 hover:ring-white/10 hover:text-zinc-400"
              }`}
            >
              {verdict} {count}
            </button>
          );
        })}

        {/* Clear filters */}
        {(filterCategory || filterVerdict) && (
          <button
            onClick={() => {
              onFilterCategory(null);
              onFilterVerdict(null);
            }}
            className="text-[10px] text-zinc-500 hover:text-zinc-400 transition-colors ml-auto"
          >
            Clear
          </button>
        )}
      </div>

      {/* Queue List — independently scrollable */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-0">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-12 px-3 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-zinc-800 animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-3/4 bg-zinc-800 rounded animate-pulse" />
                  <div className="h-2.5 w-1/2 bg-zinc-800 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : drafts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <div className="text-sm text-zinc-400">No drafts pending</div>
            {pipelineSummary && (pipelineSummary.responderSkippedLast7d > 0 || pipelineSummary.producedLast7d > 0) ? (
              <div className="max-w-xs text-[11px] leading-relaxed text-zinc-500">
                This is expected. In the last 7 days the responder produced{" "}
                <span className="text-zinc-300">{pipelineSummary.producedLast7d}</span> draft
                {pipelineSummary.producedLast7d === 1 ? "" : "s"} and skipped{" "}
                <span className="text-zinc-300">{pipelineSummary.responderSkippedLast7d}</span> message
                {pipelineSummary.responderSkippedLast7d === 1 ? "" : "s"} whose sender isn&apos;t in a
                draftable tier (the tier opt-in gate).
                {pipelineSummary.autoArchivedLast7d > 0 && (
                  <>
                    {" "}
                    <span className="text-zinc-300">{pipelineSummary.autoArchivedLast7d}</span> created
                    draft{pipelineSummary.autoArchivedLast7d === 1 ? " was" : "s were"} auto-archived
                    (no reply needed).
                  </>
                )}{" "}
                Promote a contact&apos;s tier to start drafting for them.
              </div>
            ) : (
              <div className="text-[11px] text-zinc-600">You&apos;re all caught up.</div>
            )}
          </div>
        ) : (
          <>
            {/* High-confidence group */}
            {highConfidence.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-3 py-2 bg-emerald-500/5 border-b border-white/5">
                  <span className="text-[11px] uppercase tracking-wider text-emerald-400 font-medium">
                    Ready to send ({highConfidence.length})
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onBulkApproveReady();
                    }}
                    className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
                  >
                    Approve &amp; Send all
                  </button>
                </div>
                {highConfidence.map((draft) => {
                  const globalIdx = orderedDrafts.indexOf(draft);
                  return (
                    <QueueItem
                      key={draft.id}
                      draft={draft}
                      isSelected={selectedDrafts.has(draft.id)}
                      isActive={selectedDraftId === draft.id}
                      isFocused={focusIndex === globalIdx}
                      onSelect={() => onToggleSelect(draft.id)}
                      onClick={() => onSelectDraft(draft.id)}
                    />
                  );
                })}
              </div>
            )}

            {/* Visual separator */}
            {highConfidence.length > 0 && needsReview.length > 0 && (
              <div className="h-px bg-white/5" />
            )}

            {/* Needs review group */}
            {needsReview.length > 0 && (
              <div>
                {highConfidence.length > 0 && (
                  <div className="px-3 py-2 border-b border-white/5">
                    <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                      Needs review ({needsReview.length})
                    </span>
                  </div>
                )}
                {needsReview.map((draft) => {
                  const globalIdx = orderedDrafts.indexOf(draft);
                  return (
                    <QueueItem
                      key={draft.id}
                      draft={draft}
                      isSelected={selectedDrafts.has(draft.id)}
                      isActive={selectedDraftId === draft.id}
                      isFocused={focusIndex === globalIdx}
                      onSelect={() => onToggleSelect(draft.id)}
                      onClick={() => onSelectDraft(draft.id)}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
