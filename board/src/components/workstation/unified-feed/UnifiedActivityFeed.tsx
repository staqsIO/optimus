"use client";

import { useState, useMemo, useCallback } from "react";
import type { FeedCard, GapItem } from "../types";
import type { FeedFilter, UnifiedFeedItem } from "./types";
import { useUnifiedFeed } from "./useUnifiedFeed";
import UnifiedFeedItemCard from "./UnifiedFeedItemCard";

interface FeedCardActions {
  onIterate: (cardId: string, prompt: string) => void;
  onCreatePR: (cardId: string) => void;
  onDiscard: (cardId: string) => void;
  onCommitMessageChange: (cardId: string, message: string) => void;
  onFollowUp: (prompt: string) => void;
  onAddToSpec: (gap: GapItem) => void;
}

interface Props {
  feedCards: FeedCard[];
  feedCardActions: FeedCardActions;
}

const FILTER_OPTIONS: { value: FeedFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs Action" },
  { value: "human", label: "Board" },
  { value: "agent", label: "Agents" },
];

export default function UnifiedActivityFeed({ feedCards, feedCardActions }: Props) {
  const { items, loading, intentActions } = useUnifiedFeed(feedCards);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    switch (filter) {
      case "attention":
        return items.filter((i) => i.requiresAction);
      case "human":
        return items.filter((i) => i.actor.type === "human");
      case "agent":
        return items.filter((i) => i.actor.type === "agent");
      default:
        return items;
    }
  }, [items, filter]);

  const counts = useMemo(() => ({
    all: items.length,
    attention: items.filter((i) => i.requiresAction).length,
    human: items.filter((i) => i.actor.type === "human").length,
    agent: items.filter((i) => i.actor.type === "agent").length,
  }), [items]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-1.5">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
              filter === opt.value
                ? "bg-accent-bright/20 text-accent-bright"
                : "bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/10"
            }`}
          >
            {opt.label}
            {counts[opt.value] > 0 && (
              <span className="ml-1 text-[10px] opacity-60">{counts[opt.value]}</span>
            )}
          </button>
        ))}
        {loading && (
          <div className="ml-auto flex items-center gap-1.5 text-[10px] text-zinc-600">
            <div className="w-3 h-3 border border-zinc-600 border-t-zinc-400 rounded-full animate-spin" />
            Updating...
          </div>
        )}
      </div>

      {/* Feed items — grouped when consecutive same-agent+source */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-600 text-sm">
          {filter === "attention"
            ? "Nothing needs your attention right now."
            : "No activity yet. Use the command bar to get started."}
        </div>
      ) : (
        <div className="space-y-2">
          {groupConsecutive(filtered).map((group) =>
            group.length === 1 ? (
              <UnifiedFeedItemCard
                key={group[0].id}
                item={group[0]}
                expanded={expandedId === group[0].id}
                onToggle={() => toggleExpand(group[0].id)}
                feedCardActions={feedCardActions}
                intentActions={intentActions}
              />
            ) : (
              <GroupedFeedItems
                key={`grp-${group[0].id}`}
                items={group}
                expandedId={expandedId}
                onToggle={toggleExpand}
                feedCardActions={feedCardActions}
                intentActions={intentActions}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Group consecutive items from the same agent+source into arrays */
function groupConsecutive(items: UnifiedFeedItem[]): UnifiedFeedItem[][] {
  const groups: UnifiedFeedItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0].source === item.source &&
      last[0].actor.id === item.actor.id &&
      last.length < 5 // max group size
    ) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

/** Collapsed group of similar feed items */
function GroupedFeedItems({
  items,
  expandedId,
  onToggle,
  feedCardActions,
  intentActions,
}: {
  items: UnifiedFeedItem[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  feedCardActions: FeedCardActions;
  intentActions: { approve: (id: string) => Promise<void>; reject: (id: string, feedback: string | null) => Promise<void> };
}) {
  const [expanded, setExpanded] = useState(false);
  const first = items[0];
  const actorLabel = first.actor.type === "human" ? "Board" : first.actor.id;
  const actionCount = items.filter((i) => i.requiresAction).length;

  return (
    <div className={`rounded-xl border overflow-hidden ${
      actionCount > 0 ? "border-amber-500/20" : "border-white/5"
    }`}>
      {/* Group header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-bold text-blue-300">{items.length}</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-zinc-200">{actorLabel}</span>
          <span className="text-[10px] text-zinc-500 ml-1.5">
            {items.length} similar items
          </span>
          {actionCount > 0 && (
            <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
              {actionCount} need action
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-zinc-600 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Expanded: show all items */}
      {expanded && (
        <div className="border-t border-white/5 divide-y divide-white/5">
          {items.map((item) => (
            <UnifiedFeedItemCard
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() => onToggle(item.id)}
              feedCardActions={feedCardActions}
              intentActions={intentActions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
