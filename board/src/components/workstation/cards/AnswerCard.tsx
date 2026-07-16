"use client";

import { useState } from "react";
import type { FeedCard } from "../types";

type AnswerCardData = Extract<FeedCard, { type: "answer" }>;

const EXPERT_NAMES: Record<string, string> = {
  strategy: "Strategy Analysis",
  architecture: "Architecture Review",
  governance: "Governance & Spec",
  operations: "Operations",
};

interface AnswerCardProps {
  card: AnswerCardData;
  expanded: boolean;
  onToggle: () => void;
  onFollowUp: (prompt: string) => void;
}

export default function AnswerCard({
  card,
  expanded,
  onToggle,
  onFollowUp,
}: AnswerCardProps) {
  const [followUpInput, setFollowUpInput] = useState("");

  const isLoading = card.stage === "loading";
  const isCommand = !!card.action;
  const statusLabel = isLoading ? "Thinking..." : card.error ? "Error" : isCommand ? "Dispatched" : "Answered";

  return (
    <div className={`bg-white/[0.02] border border-white/5 rounded-xl border-l-4 overflow-hidden ${isCommand ? "border-l-green-500/60" : "border-l-blue-500/60"}`}>
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className={`px-2 py-0.5 text-[10px] font-medium rounded flex-shrink-0 ${isCommand ? "bg-green-500/20 text-green-300" : "bg-blue-500/20 text-blue-300"}`}>
          {isCommand ? "Command" : "Answer"}
        </span>
        <span className="text-sm text-zinc-300 truncate flex-1">{card.input}</span>
        <span className="text-xs text-zinc-500 flex-shrink-0">{statusLabel}</span>
        {isLoading && (
          <div className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin flex-shrink-0" />
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
          {/* Error */}
          {card.error && (
            <div className="mt-3 px-4 py-3 text-sm bg-red-500/10 text-red-400 rounded-lg border border-red-500/20">
              {card.error}
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="mt-3 p-5 text-center text-zinc-400 text-sm">
              Thinking...
            </div>
          )}

          {/* Answer */}
          {card.answer && (
            <div className="mt-3 space-y-3">
              {/* Expert attribution */}
              {card.expert && (
                <p className="text-xs text-zinc-600">
                  Answered from{" "}
                  <span className="text-zinc-400">
                    {EXPERT_NAMES[card.expert] || card.expert}
                  </span>{" "}
                  perspective
                  {card.filesUsed && card.filesUsed.length > 0 &&
                    ` using ${card.filesUsed.length} file${card.filesUsed.length === 1 ? "" : "s"}`}
                </p>
              )}

              {/* Answer text */}
              <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
                {card.answer}
              </div>

              {/* Action confirmation */}
              {card.action && (
                <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
                  <span className="text-green-400 text-xs">&#x2713;</span>
                  <span className="text-xs text-green-300">
                    Task created{card.action.assignedTo ? ` → ${card.action.assignedTo}` : ""}
                  </span>
                  {card.action.title && (
                    <span className="text-xs text-zinc-500 truncate">
                      &mdash; {card.action.title}
                    </span>
                  )}
                  {card.action.linearUrl && (
                    <a
                      href={card.action.linearUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Linear &rarr;
                    </a>
                  )}
                </div>
              )}

              {/* Files used pills */}
              {card.filesUsed && card.filesUsed.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {card.filesUsed.map((f) => (
                    <span
                      key={f}
                      className="px-2 py-0.5 text-[10px] bg-white/[0.04] text-zinc-500 rounded border border-white/5"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}

              {/* Follow-up input */}
              <div className="flex gap-2 pt-2">
                <input
                  type="text"
                  value={followUpInput}
                  onChange={(e) => setFollowUpInput(e.target.value)}
                  placeholder="Ask a follow-up..."
                  className="flex-1 px-3 py-1.5 text-sm bg-white/[0.03] border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && followUpInput.trim()) {
                      onFollowUp(followUpInput);
                      setFollowUpInput("");
                    }
                  }}
                />
                <button
                  onClick={() => {
                    if (followUpInput.trim()) {
                      onFollowUp(followUpInput);
                      setFollowUpInput("");
                    }
                  }}
                  disabled={!followUpInput.trim()}
                  className="px-3 py-1.5 text-xs bg-blue-500/15 text-blue-300 rounded-lg hover:bg-blue-500/25 transition-colors border border-blue-500/20 disabled:opacity-40"
                >
                  Ask
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
