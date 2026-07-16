"use client";

import { type Draft, ALL_GATES, GATE_LABELS } from "./QueueItem";

// ---------------------------------------------------------------------------
// IntelligenceBar — Always-visible 3-zone signal strip
// ---------------------------------------------------------------------------

export default function IntelligenceBar({ draft }: { draft: Draft }) {
  const gateResults = draft.gate_results ?? {};
  const passedCount = Object.values(gateResults).filter((v) => v.passed).length;
  const totalGates = Math.max(Object.keys(gateResults).length, ALL_GATES.length);

  const toneScore = draft.tone_score != null ? Math.round(Number(draft.tone_score) * 100) : null;
  const toneColor =
    toneScore === null
      ? "bg-zinc-600"
      : toneScore >= 80
        ? "bg-emerald-500"
        : toneScore >= 50
          ? "bg-amber-500"
          : "bg-red-500";

  const isHighConfidence = draft.confidence_tier === "high";

  // Progressive disclosure: compact one-line for high-confidence
  if (isHighConfidence) {
    return (
      <div className="px-4 py-2 bg-emerald-500/5 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-xs text-emerald-400 font-medium">All checks passed</span>
          {toneScore !== null && (
            <span className="text-xs text-zinc-500 ml-auto tabular-nums">{toneScore}% tone match</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-white/5 bg-surface-overlay/30">
      <div className="grid grid-cols-3 gap-4">
        {/* Zone 1 — Intent pair */}
        <div className="space-y-2">
          <div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">
              They want
            </div>
            <div className="text-sm text-zinc-200 leading-snug line-clamp-2">
              {draft.email_summary || "Not analyzed"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">
              AI draft does
            </div>
            <div className="text-sm text-zinc-200 leading-snug line-clamp-2">
              {draft.draft_intent || "Not analyzed"}
            </div>
          </div>
        </div>

        {/* Zone 2 — Tone match */}
        <div className="flex flex-col justify-center">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
            Tone match {toneScore !== null ? `${toneScore}%` : "--"}
          </div>
          <div className="h-1.5 rounded-full bg-zinc-700 overflow-hidden">
            {toneScore !== null && (
              <div
                className={`h-full rounded-full transition-all duration-300 ${toneColor}`}
                style={{ width: `${toneScore}%` }}
              />
            )}
          </div>
          {draft.reviewer_notes && (
            <div className="text-[10px] text-zinc-500 mt-1.5 italic truncate">
              {draft.reviewer_notes}
            </div>
          )}
        </div>

        {/* Zone 3 — Gate status */}
        <div className="flex flex-col justify-center">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
            Gates {passedCount}/{totalGates}
          </div>
          <div className="flex items-center gap-1">
            {ALL_GATES.map((gate) => {
              const result = gateResults[gate];
              const passed = result?.passed !== false;
              const hasResult = !!result;
              return (
                <div
                  key={gate}
                  className={`h-2 w-2 rounded-full ${
                    !hasResult
                      ? "bg-zinc-700"
                      : passed
                        ? "bg-emerald-500"
                        : "border border-red-500 bg-transparent"
                  }`}
                  title={`${gate}: ${GATE_LABELS[gate]}${result?.detail ? ` - ${result.detail}` : !hasResult ? " - N/A" : passed ? " - passed" : " - failed"}`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
