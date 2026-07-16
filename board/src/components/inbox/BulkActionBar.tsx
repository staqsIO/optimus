"use client";

// ---------------------------------------------------------------------------
// BulkActionBar — Bottom bar on multi-select
// ---------------------------------------------------------------------------

export default function BulkActionBar({
  count,
  readyCount,
  safeInSelectionCount,
  submitting,
  onAction,
  onApproveSafeOnly,
  onClear,
}: {
  count: number;
  readyCount?: number;
  /** High-confidence drafts in the current selection (for safe batch send). */
  safeInSelectionCount?: number;
  submitting: boolean;
  onAction: (action: "send" | "approve" | "reject") => void;
  /** When selection mixes tiers, send only high-confidence IDs. */
  onApproveSafeOnly?: () => void;
  onClear: () => void;
}) {
  const mixed =
    safeInSelectionCount != null &&
    safeInSelectionCount > 0 &&
    safeInSelectionCount < count;

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[min(100vw-2rem,42rem)]
                 bg-surface-overlay/95 backdrop-blur-xl border border-white/10
                 rounded-xl px-5 py-3 shadow-2xl shadow-black/40
                 flex flex-col sm:flex-row sm:items-center gap-3 animate-slide-up"
      style={{ animation: "slideUp 200ms cubic-bezier(0.4, 0, 0.2, 1)" }}
      role="toolbar"
      aria-label="Bulk draft actions"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-zinc-200 tabular-nums">
          {count} selected
        </span>

        {readyCount != null && readyCount > 0 && (
          <span className="text-[10px] text-emerald-400/90">
            {readyCount} ready in queue
          </span>
        )}

        {mixed && (
          <span className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5">
            Selection includes drafts that need review — prefer “Ready only” or review each.
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        {mixed && onApproveSafeOnly && safeInSelectionCount != null && (
          <button
            type="button"
            onClick={() => onApproveSafeOnly()}
            disabled={submitting}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-lg
                     transition-colors disabled:opacity-50 text-sm order-first sm:order-none"
          >
            {submitting ? "…" : `Approve & send ${safeInSelectionCount} ready only`}
          </button>
        )}

        <button
          type="button"
          onClick={() => onAction("send")}
          disabled={submitting}
          className={`font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50 text-sm ${
            mixed
              ? "border border-amber-500/40 text-amber-100 hover:bg-amber-500/10"
              : "bg-emerald-600 hover:bg-emerald-500 text-white"
          }`}
        >
          {submitting ? "Processing…" : mixed ? `Send all ${count}` : `Approve & send ${count}`}
        </button>

        <button
          type="button"
          onClick={() => onAction("reject")}
          disabled={submitting}
          className="px-4 py-2 text-sm text-zinc-400 rounded-lg
                   hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
        >
          Reject {count}
        </button>

        <div className="hidden sm:block h-4 w-px bg-white/10" />

        <button
          type="button"
          onClick={onClear}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
