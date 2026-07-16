"use client";

import type { ResearchResult, GapItem } from "./types";

interface ResearchPanelProps {
  researchInput: string;
  stage: string;
  result: ResearchResult | null;
  error: string;
  onInputChange: (input: string) => void;
  onSubmit: () => void;
  onReset: () => void;
  onCreateSpecAddendum: (gap: GapItem) => void;
}

export default function ResearchPanel({
  researchInput,
  stage,
  result,
  error,
  onInputChange,
  onSubmit,
  onReset,
  onCreateSpecAddendum,
}: ResearchPanelProps) {
  const isLoading = stage === "loading";
  const isUrl = /^https?:\/\//i.test(researchInput.trim());

  // Input stage
  if (stage === "input" || isLoading) {
    return (
      <div className="space-y-4">
        <div className="space-y-3 p-5 bg-surface-raised rounded-lg border border-white/5">
          <label className="block text-xs text-zinc-500 mb-1.5">
            Paste a URL or article text to analyze against the spec
          </label>
          <textarea
            value={researchInput}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="https://example.com/article or paste text directly..."
            rows={6}
            className="w-full px-3 py-2 text-sm bg-surface border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-y"
          />
          <div className="flex justify-between items-center">
            <p className="text-xs text-zinc-600">
              {isUrl
                ? "URL detected — content will be fetched and analyzed"
                : researchInput.trim()
                  ? `${researchInput.length.toLocaleString()} characters`
                  : "Runs on a remote agent — no API tokens used"}
            </p>
            <button
              onClick={onSubmit}
              disabled={!researchInput.trim() || isLoading}
              className="px-4 py-2 text-sm bg-accent hover:bg-accent-dim text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isLoading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 py-3 text-sm bg-red-500/10 text-red-400 rounded-lg border border-red-500/20">
            {error}
          </div>
        )}
      </div>
    );
  }

  // Results stage
  if (stage === "research-results" && result) {
    return (
      <div className="space-y-4">
        {/* Summary */}
        <div className="p-5 bg-surface-raised rounded-lg border border-white/5">
          <h3 className="text-sm font-medium text-zinc-200 mb-2">Summary</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {result.summary}
          </p>
          {result.sourceType === "url" && (
            <p className="text-xs text-zinc-600 mt-2">
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

        {/* Gaps — actionable findings */}
        {result.gaps.length > 0 && (
          <div className="p-5 bg-surface-raised rounded-lg border border-emerald-500/20">
            <h3 className="text-sm font-medium text-emerald-400 mb-3">
              Relevant Gaps ({result.gaps.length})
            </h3>
            <div className="space-y-3">
              {result.gaps.map((gap) => (
                <div
                  key={gap.id}
                  className="p-3 bg-surface rounded-lg border border-white/5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-200">
                        {gap.title}
                      </p>
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                        {gap.description}
                      </p>
                      {gap.specSection && (
                        <p className="text-xs text-zinc-600 mt-1">
                          {gap.specSection}
                        </p>
                      )}
                      {gap.suggestedAction && (
                        <p className="text-xs text-accent-bright mt-1">
                          {gap.suggestedAction}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => onCreateSpecAddendum(gap)}
                      className="flex-shrink-0 px-2.5 py-1.5 text-xs bg-accent/10 text-accent-bright rounded-md hover:bg-accent/20 transition-colors border border-accent/20"
                      title="Create spec addendum from this gap"
                    >
                      Add to spec
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Already covered */}
        {result.alreadyCovered.length > 0 && (
          <div className="p-5 bg-surface-raised rounded-lg border border-white/5">
            <h3 className="text-sm font-medium text-zinc-400 mb-3">
              Already Covered ({result.alreadyCovered.length})
            </h3>
            <ul className="space-y-1.5">
              {result.alreadyCovered.map((item, i) => (
                <li
                  key={i}
                  className="text-xs text-zinc-500 flex gap-2 items-start"
                >
                  <span className="text-zinc-600 mt-0.5 flex-shrink-0">
                    &#10003;
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Not applicable */}
        {result.notApplicable.length > 0 && (
          <div className="p-5 bg-surface-raised rounded-lg border border-white/5">
            <h3 className="text-sm font-medium text-zinc-600 mb-3">
              Not Applicable ({result.notApplicable.length})
            </h3>
            <ul className="space-y-1.5">
              {result.notApplicable.map((item, i) => (
                <li
                  key={i}
                  className="text-xs text-zinc-600 flex gap-2 items-start"
                >
                  <span className="flex-shrink-0 mt-0.5">&#8212;</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onReset}
            className="px-4 py-2 text-sm bg-accent hover:bg-accent-dim text-white rounded-lg transition-colors"
          >
            Analyze another
          </button>
        </div>
      </div>
    );
  }

  return null;
}
