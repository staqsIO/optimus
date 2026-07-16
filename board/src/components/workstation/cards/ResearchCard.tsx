"use client";

import { useState } from "react";
import type { FeedCard, GapItem } from "../types";

type ResearchCardData = Extract<FeedCard, { type: "research" }>;

interface ResearchCardProps {
  card: ResearchCardData;
  expanded: boolean;
  onToggle: () => void;
  onAddToSpec: (gap: GapItem) => void;
}

export default function ResearchCard({
  card,
  expanded,
  onToggle,
  onAddToSpec,
}: ResearchCardProps) {
  const [showCovered, setShowCovered] = useState(false);
  const [showNA, setShowNA] = useState(false);

  const isLoading = card.stage === "loading" || card.stage === "analyzing";
  const statusLabel = isLoading
    ? card.stage === "analyzing" ? "Analyzing..." : "Submitting..."
    : card.error
      ? "Error"
      : "Complete";

  const result = card.result;
  const gapCount = result?.gaps.length ?? 0;
  const coveredCount = result?.alreadyCovered.length ?? 0;
  const naCount = result?.notApplicable.length ?? 0;

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-xl border-l-4 border-l-emerald-500/60 overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-emerald-500/20 text-emerald-300 flex-shrink-0">
          Research
        </span>
        <span className="text-sm text-zinc-300 truncate flex-1">{card.input}</span>
        <span className="text-xs text-zinc-500 flex-shrink-0">{statusLabel}</span>
        {isLoading && (
          <div className="w-4 h-4 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin flex-shrink-0" />
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
        <div className="px-4 pb-4 space-y-4 border-t border-white/5">
          {/* Error */}
          {card.error && (
            <div className="mt-3 px-4 py-3 text-sm bg-red-500/10 text-red-400 rounded-lg border border-red-500/20">
              {card.error}
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="mt-3 p-5 text-center text-zinc-400 text-sm">
              {card.stage === "analyzing"
                ? "Agent is analyzing content against the spec..."
                : "Submitting to research agent..."}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="mt-3 space-y-4">
              {/* Summary banner with counts */}
              <div className="flex flex-wrap items-center gap-3 p-3 bg-surface-raised rounded-lg border border-white/5">
                {gapCount > 0 && (
                  <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
                    {gapCount} gap{gapCount !== 1 ? "s" : ""} found
                  </span>
                )}
                {coveredCount > 0 && (
                  <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
                    {coveredCount} covered
                  </span>
                )}
                {naCount > 0 && (
                  <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-zinc-500/15 text-zinc-400 border border-zinc-500/20">
                    {naCount} N/A
                  </span>
                )}
                {gapCount === 0 && (
                  <span className="text-xs text-emerald-400">No gaps detected</span>
                )}
              </div>

              {/* Summary */}
              <div>
                <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Summary</h4>
                <p className="text-sm text-zinc-300 leading-relaxed">{result.summary}</p>
                {result.sourceType === "url" && (
                  <p className="text-xs text-zinc-600 mt-1">
                    Source:{" "}
                    <a
                      href={result.sourceContent}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-bright hover:underline"
                    >
                      {result.sourceContent}
                    </a>
                  </p>
                )}
              </div>

              {/* Gaps — amber border, table layout for 3+ */}
              {gapCount > 0 && (
                <div className="rounded-lg border border-amber-500/20 overflow-hidden">
                  <div className="px-4 py-2.5 bg-amber-500/5 border-b border-amber-500/20">
                    <h4 className="text-sm font-medium text-amber-300">
                      Gaps ({gapCount})
                    </h4>
                  </div>
                  {gapCount >= 3 ? (
                    /* Compact table for 3+ gaps */
                    <div className="divide-y divide-white/5">
                      {result.gaps.map((gap) => (
                        <div key={gap.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02]">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-zinc-200 truncate">{gap.title}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {gap.specSection && (
                                <span className="text-[10px] text-zinc-600">{gap.specSection}</span>
                              )}
                              {gap.suggestedAction && (
                                <span className="text-[10px] text-accent-bright truncate">{gap.suggestedAction}</span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => onAddToSpec(gap)}
                            className="flex-shrink-0 px-2.5 py-1.5 text-xs bg-accent/10 text-accent-bright rounded-md hover:bg-accent/20 transition-colors border border-accent/20"
                          >
                            Add to spec
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Card layout for 1-2 gaps */
                    <div className="p-3 space-y-3">
                      {result.gaps.map((gap) => (
                        <div key={gap.id} className="p-3 bg-surface rounded-lg border border-white/5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-zinc-200">{gap.title}</p>
                              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{gap.description}</p>
                              {gap.specSection && (
                                <p className="text-xs text-zinc-600 mt-1">{gap.specSection}</p>
                              )}
                              {gap.suggestedAction && (
                                <p className="text-xs text-accent-bright mt-1">{gap.suggestedAction}</p>
                              )}
                            </div>
                            <button
                              onClick={() => onAddToSpec(gap)}
                              className="flex-shrink-0 px-2.5 py-1.5 text-xs bg-accent/10 text-accent-bright rounded-md hover:bg-accent/20 transition-colors border border-accent/20"
                              title="Create spec addendum from this gap"
                            >
                              Add to spec
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Already covered — emerald border, collapsible */}
              {coveredCount > 0 && (
                <div className={`rounded-lg border ${showCovered ? "border-emerald-500/20" : "border-white/5"} overflow-hidden`}>
                  <button
                    onClick={() => setShowCovered((v) => !v)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
                  >
                    <span className="text-[10px]">{showCovered ? "\u25BC" : "\u25B6"}</span>
                    <span className="text-xs text-emerald-400">Already Covered ({coveredCount})</span>
                  </button>
                  {showCovered && (
                    <div className="px-4 pb-3 border-t border-white/5">
                      <ul className="mt-2 space-y-1.5">
                        {result.alreadyCovered.map((item, i) => (
                          <li key={i} className="text-xs text-zinc-500 flex gap-2 items-start">
                            <span className="text-emerald-600 mt-0.5 flex-shrink-0">&#10003;</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Not applicable — zinc border, collapsible */}
              {naCount > 0 && (
                <div className={`rounded-lg border ${showNA ? "border-zinc-500/20" : "border-white/5"} overflow-hidden`}>
                  <button
                    onClick={() => setShowNA((v) => !v)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
                  >
                    <span className="text-[10px]">{showNA ? "\u25BC" : "\u25B6"}</span>
                    <span className="text-xs text-zinc-500">Not Applicable ({naCount})</span>
                  </button>
                  {showNA && (
                    <div className="px-4 pb-3 border-t border-white/5">
                      <ul className="mt-2 space-y-1.5">
                        {result.notApplicable.map((item, i) => (
                          <li key={i} className="text-xs text-zinc-600 flex gap-2 items-start">
                            <span className="flex-shrink-0 mt-0.5">&#8212;</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
