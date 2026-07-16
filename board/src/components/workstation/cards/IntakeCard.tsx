"use client";

import type { FeedCard } from "../types";

type IntakeCardData = Extract<FeedCard, { type: "intake" }>;

interface IntakeCardProps {
  card: IntakeCardData;
  expanded: boolean;
  onToggle: () => void;
  onDiscard: (id: string) => void;
}

export default function IntakeCard({
  card,
  expanded,
  onToggle,
  onDiscard,
}: IntakeCardProps) {
  const isSubmitting = card.stage === "submitting";
  const isClassified = card.stage === "classified";
  const statusLabel = isSubmitting
    ? "Submitting..."
    : card.error
      ? "Error"
      : isClassified
        ? "Classified"
        : "Submitted";

  const classification = card.classification as Record<string, unknown> | undefined;

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-xl border-l-4 border-l-amber-500/60 overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-amber-500/20 text-amber-300 flex-shrink-0">
          Intake
        </span>
        <span className="text-sm text-zinc-300 truncate flex-1">{card.input}</span>
        <span className="text-xs text-zinc-500 flex-shrink-0">{statusLabel}</span>
        {isSubmitting && (
          <div className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin flex-shrink-0" />
        )}
        {isClassified && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 flex-shrink-0">
            Auto-classified
          </span>
        )}
        <svg
          className={`w-4 h-4 text-zinc-500 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/5">
          {card.error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300">
              {card.error}
            </div>
          )}

          {!card.error && card.stage === "submitted" && !isClassified && (
            <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/10 rounded-lg text-xs text-amber-300">
              Submitted to governance inbox. Haiku is classifying...
            </div>
          )}

          {isClassified && classification && (
            <div className="mt-3 space-y-2">
              <div className="p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-lg text-xs text-zinc-300 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500">Category:</span>
                  <span className="text-emerald-400 font-medium">
                    {(classification.category as string) || "Pending"}
                  </span>
                </div>
                {classification.constitutional_alignment != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500">Constitutional:</span>
                    <span className="text-zinc-300">
                      {`${classification.constitutional_alignment}`}
                    </span>
                  </div>
                )}
                {classification.reasoning != null && (
                  <div className="text-zinc-400 text-[11px] mt-1">
                    {`${classification.reasoning}`}
                  </div>
                )}
              </div>
              <div className="text-[10px] text-zinc-600">
                View in{" "}
                <a href="/governance" className="text-accent-bright hover:underline">
                  Governance Inbox
                </a>
              </div>
            </div>
          )}

          {!card.error && card.stage === "submitted" && (
            <div className="mt-2 text-[10px] text-zinc-600">
              Submission ID: {card.submissionId || "..."}
              {" \u2022 "}
              <a href="/governance" className="text-accent-bright hover:underline">
                View in Governance
              </a>
            </div>
          )}

          <div className="flex justify-end mt-2">
            <button
              onClick={() => onDiscard(card.id)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
