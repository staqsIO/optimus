"use client";

import { useState } from "react";
import type { FeedCard } from "../types";
import DiffPanel from "../DiffPanel";

type ChangeCardData = Extract<FeedCard, { type: "change" }>;

interface ChangeCardProps {
  card: ChangeCardData;
  expanded: boolean;
  onToggle: () => void;
  onIterate: (cardId: string, prompt: string) => void;
  onCreatePR: (cardId: string) => void;
  onDiscard: (cardId: string) => void;
  onCommitMessageChange: (cardId: string, message: string) => void;
}

export default function ChangeCard({
  card,
  expanded,
  onToggle,
  onIterate,
  onCreatePR,
  onDiscard,
  onCommitMessageChange,
}: ChangeCardProps) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [iterateInput, setIterateInput] = useState("");

  const isLoading = card.stage === "loading" || card.stage === "iterating";
  const isDone = card.stage === "done";
  const isCreatingPR = card.stage === "creating-pr";

  const statusLabel = isLoading
    ? card.stage === "iterating" ? "Iterating..." : "Generating..."
    : isCreatingPR
      ? "Creating PR..."
      : isDone
        ? "PR Created"
        : card.error
          ? "Error"
          : "Ready for review";

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-xl border-l-4 border-l-purple-500/60 overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-purple-500/20 text-purple-300 flex-shrink-0">
          Change
        </span>
        <span className="text-sm text-zinc-300 truncate flex-1">{card.input}</span>
        <span className="text-xs text-zinc-500 flex-shrink-0">{statusLabel}</span>
        {isLoading && (
          <div className="w-4 h-4 border-2 border-purple-400/30 border-t-purple-400 rounded-full animate-spin flex-shrink-0" />
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

          {/* Loading state */}
          {isLoading && !card.result && (
            <div className="mt-3 p-5 text-center text-zinc-400 text-sm">
              {card.stage === "iterating" ? "Re-generating with your feedback..." : "Generating changes..."}
            </div>
          )}

          {/* PR done state */}
          {isDone && card.prUrl && (
            <div className="mt-3 p-4 bg-surface-raised rounded-lg border border-green-500/20 space-y-2">
              <p className="text-sm text-green-400">PR created successfully!</p>
              <a
                href={card.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent-bright hover:underline break-all"
              >
                {card.prUrl}
              </a>
            </div>
          )}

          {/* Creating PR */}
          {isCreatingPR && (
            <div className="mt-3 p-5 text-center text-zinc-400 text-sm">
              Creating PR...
            </div>
          )}

          {/* Preview state — show diff panel inline */}
          {card.stage === "preview" && card.result && (
            <div className="mt-3">
              <DiffPanel
                result={card.result}
                commitMessage={card.commitMessage || ""}
                iteratePrompt={iterateInput}
                showReasoning={showReasoning}
                onCommitMessageChange={(msg) => onCommitMessageChange(card.id, msg)}
                onIteratePromptChange={setIterateInput}
                onToggleReasoning={() => setShowReasoning((v) => !v)}
                onIterate={() => {
                  if (iterateInput.trim()) {
                    onIterate(card.id, iterateInput);
                    setIterateInput("");
                  }
                }}
                onCreatePR={() => onCreatePR(card.id)}
                onDiscard={() => onDiscard(card.id)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
