"use client";

import { useState } from "react";
import type { UnifiedFeedItem } from "./types";
import type { GapItem } from "../types";
import { getAgentDisplay } from "@/lib/agent-display";
import ChangeCard from "../cards/ChangeCard";
import AnswerCard from "../cards/AnswerCard";
import ResearchCard from "../cards/ResearchCard";
import IntakeCard from "../cards/IntakeCard";

interface FeedCardActions {
  onIterate: (cardId: string, prompt: string) => void;
  onCreatePR: (cardId: string) => void;
  onDiscard: (cardId: string) => void;
  onCommitMessageChange: (cardId: string, message: string) => void;
  onFollowUp: (prompt: string) => void;
  onAddToSpec: (gap: GapItem) => void;
}

interface Props {
  item: UnifiedFeedItem;
  expanded: boolean;
  onToggle: () => void;
  feedCardActions: FeedCardActions;
  intentActions: {
    approve: (id: string) => Promise<void>;
    reject: (id: string, feedback: string | null) => Promise<void>;
  };
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function ActorAvatar({ item }: { item: UnifiedFeedItem }) {
  if (item.actor.type === "human") {
    return (
      <div className="w-7 h-7 rounded-lg bg-accent-bright/20 flex items-center justify-center flex-shrink-0">
        <span className="text-[10px] font-bold text-accent-bright">BD</span>
      </div>
    );
  }
  const display = getAgentDisplay(item.actor.id);
  return (
    <div className={`w-7 h-7 rounded-lg ${display.color} flex items-center justify-center flex-shrink-0`}>
      <span className="text-[9px] font-bold text-white">{display.initials}</span>
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    feed_card: "bg-blue-500/10 text-blue-400",
    agent_work: "bg-emerald-500/10 text-emerald-400",
    agent_work_ip: "bg-amber-500/10 text-amber-400",
    governance: "bg-purple-500/10 text-purple-400",
    activity_step: "bg-zinc-500/10 text-zinc-400",
    agent_intent: "bg-red-500/10 text-red-400",
  };
  const labels: Record<string, string> = {
    feed_card: "Board",
    agent_work: "Completed",
    agent_work_ip: "In Progress",
    governance: "Governance",
    activity_step: "Activity",
    agent_intent: "Intent",
  };
  return (
    <span className={`px-1.5 py-0.5 text-[9px] rounded ${colors[source] || "bg-zinc-500/10 text-zinc-400"}`}>
      {labels[source] || source}
    </span>
  );
}

export default function UnifiedFeedItemCard({ item, expanded, onToggle, feedCardActions, intentActions }: Props) {
  // For feed_card source, delegate entirely to existing card components
  if (item.source === "feed_card") {
    const card = item.card;
    switch (card.type) {
      case "change":
        return (
          <ChangeCard
            card={card}
            expanded={expanded}
            onToggle={onToggle}
            onIterate={feedCardActions.onIterate}
            onCreatePR={feedCardActions.onCreatePR}
            onDiscard={feedCardActions.onDiscard}
            onCommitMessageChange={feedCardActions.onCommitMessageChange}
          />
        );
      case "answer":
        return (
          <AnswerCard
            card={card}
            expanded={expanded}
            onToggle={onToggle}
            onFollowUp={feedCardActions.onFollowUp}
          />
        );
      case "research":
        return (
          <ResearchCard
            card={card}
            expanded={expanded}
            onToggle={onToggle}
            onAddToSpec={feedCardActions.onAddToSpec}
          />
        );
      case "intake":
        return (
          <IntakeCard
            card={card}
            expanded={expanded}
            onToggle={onToggle}
            onDiscard={feedCardActions.onDiscard}
          />
        );
    }
  }

  // Generic social card for agent/governance/activity items
  const actorLabel = item.actor.type === "human"
    ? "Board"
    : getAgentDisplay(item.actor.id).displayName;

  // Extract a title for items that have one
  const itemTitle = item.source === "agent_intent" ? item.intent.title
    : item.source === "agent_work" ? item.completion.title
    : item.source === "agent_work_ip" ? item.inProgress.title
    : item.source === "governance" ? item.item.title
    : null;

  // Border color by source type for visual variety
  const borderColor = item.requiresAction ? "border-l-amber-500/60"
    : item.source === "agent_work" ? "border-l-emerald-500/40"
    : item.source === "agent_work_ip" ? "border-l-blue-500/40"
    : item.source === "governance" ? "border-l-purple-500/40"
    : item.source === "activity_step" ? "border-l-zinc-500/30"
    : "border-l-zinc-500/20";

  return (
    <div className={`bg-white/[0.02] border border-white/5 rounded-xl border-l-4 ${borderColor} overflow-hidden transition-colors`}>
      {/* Header — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <ActorAvatar item={item} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-zinc-200">{actorLabel}</span>
            <span className="text-[10px] text-zinc-500">{item.verb}</span>
            <span className="text-[10px] text-zinc-600">{timeAgo(item.timestamp)}</span>
          </div>
          {itemTitle && (
            <div className="text-xs text-zinc-400 truncate mt-0.5">{itemTitle}</div>
          )}
          <div className="flex items-center gap-1.5 mt-0.5">
            <SourceBadge source={item.source} />
            {item.requiresAction && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                Action needed
              </span>
            )}
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-zinc-600 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-white/5">
          <FeedItemDetail item={item} intentActions={intentActions} />
        </div>
      )}
    </div>
  );
}

function FeedItemDetail({
  item,
  intentActions,
}: {
  item: UnifiedFeedItem;
  intentActions: { approve: (id: string) => Promise<void>; reject: (id: string, feedback: string | null) => Promise<void> };
}) {
  const [rejectFeedback, setRejectFeedback] = useState("");

  switch (item.source) {
    case "agent_work":
      return (
        <div className="mt-3 space-y-2 text-xs text-zinc-300">
          <div><span className="text-zinc-500">Task:</span> {item.completion.title}</div>
          <div><span className="text-zinc-500">Type:</span> {item.completion.type}</div>
          <div><span className="text-zinc-500">Status:</span> {item.completion.status}</div>
          {item.completion.costUsd != null && (
            <div><span className="text-zinc-500">Cost:</span> ${item.completion.costUsd.toFixed(4)}</div>
          )}
          {item.completion.campaignGoal && (
            <div><span className="text-zinc-500">Campaign:</span> {item.completion.campaignGoal}</div>
          )}
        </div>
      );

    case "agent_work_ip":
      return (
        <div className="mt-3 space-y-1 text-xs text-zinc-300">
          <div><span className="text-zinc-500">Task:</span> {item.inProgress.title}</div>
          <div><span className="text-zinc-500">Status:</span> {item.inProgress.status}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <div className="w-3 h-3 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin" />
            <span className="text-amber-400/70 text-[10px]">In progress...</span>
          </div>
        </div>
      );

    case "governance":
      return (
        <div className="mt-3 space-y-2 text-xs">
          <div className="text-zinc-300">{item.item.summary}</div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">{item.item.feed_type}</span>
            {item.item.requires_action && (
              <a
                href={item.item.feed_type === "draft_review" ? "/drafts" : "/governance"}
                className="text-[10px] text-accent-bright hover:underline"
              >
                Review →
              </a>
            )}
          </div>
        </div>
      );

    case "activity_step":
      return (
        <div className="mt-3 space-y-1 text-xs text-zinc-300">
          {item.step.work_item_title && (
            <div><span className="text-zinc-500">Task:</span> {item.step.work_item_title}</div>
          )}
          <div><span className="text-zinc-500">Step:</span> {item.step.step_type}</div>
          <div><span className="text-zinc-500">Description:</span> {item.step.description}</div>
          {item.step.duration_ms != null && (
            <div>
              <span className="text-zinc-500">Duration:</span>{" "}
              {item.step.duration_ms > 1000 ? `${(item.step.duration_ms / 1000).toFixed(1)}s` : `${item.step.duration_ms}ms`}
            </div>
          )}
        </div>
      );

    case "agent_intent":
      return (
        <div className="mt-3 space-y-3">
          <div className="text-xs text-zinc-300">{item.intent.reasoning}</div>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              item.intent.decision_tier === "existential" ? "bg-red-500/10 text-red-400" :
              item.intent.decision_tier === "strategic" ? "bg-amber-500/10 text-amber-400" :
              "bg-blue-500/10 text-blue-400"
            }`}>
              {item.intent.decision_tier}
            </span>
            <span className="text-[10px] text-zinc-500">{item.intent.intent_type}</span>
          </div>
          {item.intent.status === "pending" && (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => intentActions.approve(item.intent.id)}
                className="px-3 py-1.5 text-xs bg-emerald-500/20 text-emerald-300 rounded hover:bg-emerald-500/30 transition-colors"
              >
                Approve
              </button>
              <input
                type="text"
                value={rejectFeedback}
                onChange={(e) => setRejectFeedback(e.target.value)}
                placeholder="Feedback (optional)"
                className="flex-1 px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600"
              />
              <button
                onClick={() => { intentActions.reject(item.intent.id, rejectFeedback || null); setRejectFeedback(""); }}
                className="px-3 py-1.5 text-xs bg-red-500/20 text-red-300 rounded hover:bg-red-500/30 transition-colors"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      );

    default:
      return null;
  }
}
