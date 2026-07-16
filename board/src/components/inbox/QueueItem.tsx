"use client";

import { timeAgo } from "@/components/inbox/shared";
import ToneMatchPill from "@/components/inbox/ToneMatchPill";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Draft {
  id: string;
  body: string;
  message_id: string;
  tone_score: number | null;
  reviewer_verdict: string;
  reviewer_notes: string | null;
  gate_results: Record<string, { passed: boolean; detail?: string }>;
  created_at: string;
  email_summary: string | null;
  draft_intent: string | null;
  channel: string;
  confidence_tier?: "high" | "review";
  version?: number;
  emails: {
    from_address: string;
    from_name: string;
    subject: string;
    triage_category: string;
    snippet: string;
    received_at: string;
    priority_score: number | null;
    channel: string;
    account_label: string | null;
    thread_id?: string;
  };
}

export interface PipelineStats {
  emails_received_today: number;
  action_required_today: number;
  drafts_awaiting_review: number;
  cost_today_usd: string;
  drafts_reviewed_14d: number;
  edit_rate_14d_pct: string;
}

// ---------------------------------------------------------------------------
// Constants (shared)
// ---------------------------------------------------------------------------

export const TRIAGE_COLORS: Record<string, string> = {
  action_required:
    "bg-status-action/10 text-status-action ring-status-action/20",
  needs_response:
    "bg-status-response/10 text-status-response ring-status-response/20",
  fyi: "bg-status-fyi/10 text-status-fyi ring-status-fyi/20",
  noise: "bg-zinc-700/30 text-zinc-400 ring-zinc-600/20",
  pending: "bg-zinc-700/30 text-zinc-500 ring-zinc-600/20",
};

export const GATE_LABELS: Record<string, string> = {
  G1: "Budget",
  G2: "Legal",
  G3: "Tone",
  G4: "Autonomy",
  G5: "Reversibility",
  G6: "Stakeholder",
  G7: "Precedent",
};

export const ALL_GATES = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];

// ---------------------------------------------------------------------------
// QueueItem Component
// ---------------------------------------------------------------------------

export default function QueueItem({
  draft,
  isSelected,
  isActive,
  isFocused,
  onSelect,
  onClick,
}: {
  draft: Draft;
  isSelected: boolean;
  isActive: boolean;
  isFocused: boolean;
  onSelect: () => void;
  onClick: () => void;
}) {
  const email = draft.emails;
  const triageCat = email.triage_category || "pending";
  const gateResults = draft.gate_results ?? {};
  const passedCount = Object.values(gateResults).filter((v) => v.passed).length;
  const totalGates = Object.keys(gateResults).length;

  // Verdict dot color
  const verdictDotColor: Record<string, string> = {
    approved: "bg-emerald-500",
    flagged: "bg-amber-500",
    rejected: "bg-red-500",
  };

  // Triage pill colors (compact)
  const triagePillColor: Record<string, string> = {
    action_required: "text-status-action",
    needs_response: "text-status-response",
    fyi: "text-status-fyi",
    noise: "text-zinc-500",
    pending: "text-zinc-500",
  };

  return (
    <div
      onClick={onClick}
      className={`
        group flex items-center gap-2 px-3 h-12 cursor-pointer select-none
        transition-colors duration-100
        ${isActive ? "bg-zinc-800" : ""}
        ${isSelected && !isActive ? "bg-zinc-800/50" : ""}
        ${isFocused && !isActive && !isSelected ? "bg-zinc-800/30" : ""}
        ${!isActive && !isSelected && !isFocused ? "hover:bg-zinc-800/20" : ""}
        ${isSelected ? "border-l-2 border-l-blue-500" : "border-l-2 border-l-transparent"}
      `}
    >
      {/* Checkbox (hover-reveal unless selected) */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        className={`shrink-0 ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}
      >
        <div
          className={`h-4 w-4 rounded border flex items-center justify-center transition-colors cursor-pointer
            ${
              isSelected
                ? "bg-accent border-accent"
                : "border-white/15 bg-surface-overlay hover:border-white/25"
            }`}
        >
          {isSelected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5l2.5 2.5L8 3"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>

      {/* Triage dot (8px) */}
      <div
        className={`shrink-0 h-2 w-2 rounded-full ${
          triageCat === "action_required"
            ? "bg-status-action"
            : triageCat === "needs_response"
              ? "bg-status-response"
              : triageCat === "fyi"
                ? "bg-status-fyi"
                : "bg-zinc-600"
        }`}
        title={triageCat.replace("_", " ")}
      />

      {/* Two-line content */}
      <div className="flex-1 min-w-0">
        {/* Line 1: from_name + relative time */}
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-zinc-200 truncate">
            {email.from_name || email.from_address}
          </span>
          <span className="text-xs text-zinc-500 shrink-0 ml-auto tabular-nums">
            {timeAgo(email.received_at || draft.created_at)}
          </span>
        </div>
        {/* Line 2: subject + triage pill */}
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <span className="text-xs text-zinc-400 truncate min-w-0">
            {email.subject || "(no subject)"}
          </span>
          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            <span className={`text-[10px] ${triagePillColor[triageCat] || "text-zinc-500"}`}>
              {triageCat.replace("_", " ")}
            </span>
            <ToneMatchPill toneScore={draft.tone_score} className="shrink-0" />
          </div>
        </div>
      </div>

      {/* Verdict dot */}
      <div
        className={`shrink-0 h-2 w-2 rounded-full ${verdictDotColor[draft.reviewer_verdict] || "bg-zinc-600"}`}
        title={`${draft.reviewer_verdict} (${passedCount}/${totalGates} gates)`}
      />
    </div>
  );
}
