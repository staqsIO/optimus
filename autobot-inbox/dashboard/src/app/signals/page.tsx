"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { timeAgo, StatCard, Kbd, ChannelPill } from "@/components/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SignalItem {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  resolved: boolean;
}

interface ActionItem {
  id: string;
  action_type: string;
  send_state: string;
  reviewer_verdict: string | null;
  board_action: string | null;
  tone_score: number | null;
  email_summary: string | null;
  draft_intent: string | null;
  linear_issue_url: string | null;
  github_issue_url: string | null;
  github_issue_number: number | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  target_repo: string | null;
  created_at: string;
}

interface FeedItem {
  message_id: string;
  from_address: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  triage_category: string | null;
  priority_score: number | null;
  received_at: string;
  channel: string;
  webhook_source: string | null;
  account_label: string | null;
  signals: SignalItem[];
  computed_status: string;
  actions: ActionItem[] | null;
  contact_name: string | null;
  contact_type: string | null;
  is_vip: boolean | null;
}

interface Contact {
  id: string;
  name: string | null;
  email_address: string;
  contact_type: string;
  emails_received: number;
  emails_sent: number;
  is_vip: boolean;
}

interface Topic {
  id: string;
  name: string;
  mention_count: number;
  trend_score: number;
  trend_direction: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGNAL_COLORS: Record<string, string> = {
  commitment: "bg-status-action/10 text-status-action ring-status-action/20",
  deadline: "bg-status-response/10 text-status-response ring-status-response/20",
  action_item: "bg-accent/10 text-accent-bright ring-accent/20",
  question: "bg-status-fyi/10 text-status-fyi ring-status-fyi/20",
  decision: "bg-status-approved/10 text-status-approved ring-status-approved/20",
  introduction: "bg-purple-500/10 text-purple-400 ring-purple-500/20",
  request: "bg-orange-500/10 text-orange-400 ring-orange-500/20",
};

const SIGNAL_TYPES = ["deadline", "action_item", "commitment", "question", "request", "decision", "introduction"] as const;

type SortMode = "priority" | "newest" | "due_date";
type ActionFilter = "all" | "has_action" | "has_ticket" | "has_pr" | "has_draft" | "no_action";

function dueLabel(dateStr: string) {
  const due = new Date(dateStr);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, overdue: true };
  if (diffDays === 0) return { text: "Due today", overdue: true };
  if (diffDays === 1) return { text: "Due tomorrow", overdue: false };
  if (diffDays <= 7) return { text: `Due in ${diffDays}d`, overdue: false };
  return { text: due.toLocaleDateString(), overdue: false };
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function SignalsPage() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [signalTypeFilter, setSignalTypeFilter] = useState<Set<string>>(new Set());
  const [vipOnly, setVipOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const [showRelationships, setShowRelationships] = useState(false);
  const [undoToast, setUndoToast] = useState<{ messageId: string; timeoutId: ReturnType<typeof setTimeout>; isArchive?: boolean } | null>(null);
  const [feedback, setFeedback] = useState<Record<string, "correct" | "incorrect" | null>>({});
  const listRef = useRef<HTMLDivElement>(null);

  // ---- Data fetching ----

  const fetchData = useCallback(async () => {
    try {
      const [feedRes, signalsRes] = await Promise.all([
        fetch(`${API_URL}/api/signals/feed`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${API_URL}/api/signals`, { signal: AbortSignal.timeout(8000) }),
      ]);
      const feedData = await feedRes.json();
      const signalsData = await signalsRes.json();
      setFeed(feedData?.feed || []);
      setContacts(signalsData?.contacts || []);
      setTopics(signalsData?.topics || []);
    } catch {
      // silent — will retry on interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ---- Resolve (with 5s undo window) ----

  const resolveMessage = useCallback(async (messageId: string) => {
    // Optimistically remove from feed
    const removedItem = feed.find((f) => f.message_id === messageId);
    setFeed((prev) => prev.filter((f) => f.message_id !== messageId));

    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/signals/resolve", body: { messageId } }),
      });
    } catch {
      // Restore on failure
      if (removedItem) setFeed((prev) => [...prev, removedItem]);
      return;
    }

    // Clear existing toast
    if (undoToast) clearTimeout(undoToast.timeoutId);

    // Show undo toast for 5s
    const timeoutId = setTimeout(() => setUndoToast(null), 5000);
    setUndoToast({ messageId, timeoutId, isArchive: false });
  }, [feed, undoToast]);

  const undoResolve = useCallback(async () => {
    if (!undoToast) return;
    const { messageId, timeoutId, isArchive } = undoToast;
    clearTimeout(timeoutId);
    setUndoToast(null);

    try {
      const path = isArchive ? "/api/emails/unarchive" : "/api/signals/unresolve";
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, body: { messageId } }),
      });
      fetchData();
    } catch {
      // silent
    }
  }, [undoToast, fetchData]);

  // ---- Archive (resolve all signals + archive message, with 5s undo) ----

  const archiveMessage = useCallback(async (messageId: string) => {
    const removedItem = feed.find((f) => f.message_id === messageId);
    setFeed((prev) => prev.filter((f) => f.message_id !== messageId));

    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/emails/archive", body: { messageId } }),
      });
    } catch {
      if (removedItem) setFeed((prev) => [...prev, removedItem]);
      return;
    }

    if (undoToast) clearTimeout(undoToast.timeoutId);
    const timeoutId = setTimeout(() => setUndoToast(null), 5000);
    setUndoToast({ messageId, timeoutId, isArchive: true });
  }, [feed, undoToast]);

  // ---- Signal feedback ----

  const submitFeedback = useCallback(async (signalId: string, verdict: "correct" | "incorrect") => {
    setFeedback((prev) => ({ ...prev, [signalId]: verdict }));
    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/signals/feedback", body: { signalId, verdict } }),
      });
    } catch {
      setFeedback((prev) => ({ ...prev, [signalId]: null }));
    }
  }, []);

  // ---- Filtering & Sorting ----

  const filtered = feed.filter((item) => {
    if (channelFilter !== "all" && item.channel !== channelFilter) return false;
    if (vipOnly && !item.is_vip) return false;
    if (actionFilter !== "all") {
      const actions = item.actions || [];
      if (actionFilter === "has_action" && actions.length === 0) return false;
      if (actionFilter === "has_ticket" && !actions.some(a => a.action_type === "ticket_create")) return false;
      if (actionFilter === "has_pr" && !actions.some(a => a.action_type === "code_fix_pr")) return false;
      if (actionFilter === "has_draft" && !actions.some(a => a.action_type === "email_draft" || a.action_type === "feedback_receipt")) return false;
      if (actionFilter === "no_action" && actions.length > 0) return false;
    }
    if (signalTypeFilter.size > 0) {
      const hasMatch = item.signals.some((s) => signalTypeFilter.has(s.signal_type));
      if (!hasMatch) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortMode === "newest") {
      return new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
    }
    if (sortMode === "due_date") {
      const aDue = a.signals.find((s) => s.due_date)?.due_date;
      const bDue = b.signals.find((s) => s.due_date)?.due_date;
      if (!aDue && !bDue) return 0;
      if (!aDue) return 1;
      if (!bDue) return -1;
      return new Date(aDue).getTime() - new Date(bDue).getTime();
    }
    // priority (default) — VIP first, then priority_score desc, then newest
    const vipA = a.is_vip ? 1 : 0;
    const vipB = b.is_vip ? 1 : 0;
    if (vipA !== vipB) return vipB - vipA;
    const pA = Number(a.priority_score || 0);
    const pB = Number(b.priority_score || 0);
    if (pA !== pB) return pB - pA;
    return new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
  });

  // ---- Stats ----

  const totalSignals = feed.reduce((n, f) => n + f.signals.length, 0);
  const overdueCount = feed.reduce((n, f) => {
    return n + f.signals.filter((s) => s.due_date && new Date(s.due_date) < new Date()).length;
  }, 0);
  const dueThisWeek = feed.reduce((n, f) => {
    const weekFromNow = new Date();
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    return n + f.signals.filter((s) => {
      if (!s.due_date) return false;
      const d = new Date(s.due_date);
      return d >= new Date() && d <= weekFromNow;
    }).length;
  }, 0);
  const actionsReady = feed.filter((f) => {
    if (!f.actions || f.actions.length === 0) return false;
    return f.actions.some(a =>
      a.action_type === "ticket_create" ||
      a.action_type === "code_fix_pr" ||
      ((a.action_type === "email_draft" || a.action_type === "feedback_receipt") && a.reviewer_verdict && !a.board_action)
    );
  }).length;

  // Channel counts
  const emailCount = feed.filter((f) => f.channel === "email").length;
  const slackCount = feed.filter((f) => f.channel === "slack").length;
  const webhookCount = feed.filter((f) => f.channel === "webhook").length;

  // Signal type counts (across all feed items)
  const signalTypeCounts: Record<string, number> = {};
  for (const item of feed) {
    for (const s of item.signals) {
      signalTypeCounts[s.signal_type] = (signalTypeCounts[s.signal_type] || 0) + 1;
    }
  }

  const hasActiveFilters = channelFilter !== "all" || signalTypeFilter.size > 0 || vipOnly || actionFilter !== "all";

  // ---- Keyboard navigation ----

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIndex((i) => Math.min(i + 1, sorted.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
        case "o":
          e.preventDefault();
          if (sorted[focusIndex]) {
            setExpandedId((prev) =>
              prev === sorted[focusIndex].message_id ? null : sorted[focusIndex].message_id
            );
          }
          break;
        case "r":
          e.preventDefault();
          if (sorted[focusIndex]) {
            resolveMessage(sorted[focusIndex].message_id);
          }
          break;
        case "a":
          e.preventDefault();
          if (sorted[focusIndex]) {
            archiveMessage(sorted[focusIndex].message_id);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (expandedId) setExpandedId(null);
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sorted, focusIndex, expandedId, resolveMessage, archiveMessage]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusIndex}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusIndex]);

  // ---- Loading skeleton ----

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-56 rounded bg-surface-raised animate-pulse" />
          <div className="h-5 w-24 rounded bg-surface-raised animate-pulse" />
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Signal Feed</h1>
        <span className="text-sm text-zinc-500 tabular-nums">
          {hasActiveFilters ? `${sorted.length} of ` : ""}{feed.length} messages with signals
        </span>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Unresolved" value={totalSignals} subtitle={`across ${feed.length} messages`} />
        <StatCard
          label="Overdue"
          value={overdueCount}
          color={overdueCount > 0 ? "text-status-action" : undefined}
          subtitle="past due date"
        />
        <StatCard label="Due This Week" value={dueThisWeek} subtitle="upcoming deadlines" />
        <StatCard
          label="Actions Ready"
          value={actionsReady}
          color={actionsReady > 0 ? "text-status-approved" : undefined}
          subtitle="drafts, tickets, PRs"
        />
      </div>

      {/* Empty State */}
      {feed.length === 0 && (
        <div className="bg-surface-raised rounded-lg border border-white/5 py-12 text-center">
          <div className="text-zinc-500 text-sm">No unresolved signals.</div>
          <div className="text-zinc-500 text-xs mt-1">
            Signals are extracted from emails as they arrive.
          </div>
        </div>
      )}

      {feed.length > 0 && (
        <>
          {/* Channel Filter Tabs */}
          <div className="flex items-center gap-1 border-b border-white/5 pb-0">
            {([
              { key: "all", label: "All", count: feed.length },
              { key: "email", label: "Email", count: emailCount },
              { key: "slack", label: "Slack", count: slackCount },
              { key: "webhook", label: "Webhooks", count: webhookCount },
            ] as const).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setChannelFilter(tab.key)}
                className={`px-3 py-2 text-sm font-medium transition-colors relative ${
                  channelFilter === tab.key
                    ? "text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
                <span className={`ml-1.5 text-xs tabular-nums ${
                  channelFilter === tab.key ? "text-zinc-400" : "text-zinc-500"
                }`}>
                  {tab.count}
                </span>
                {channelFilter === tab.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500 mr-1">Filter</span>

            {/* Signal type pills */}
            {SIGNAL_TYPES.filter((t) => signalTypeCounts[t]).map((type) => (
              <button
                key={type}
                onClick={() => {
                  setSignalTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  });
                }}
                className={`text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset transition-colors ${
                  signalTypeFilter.has(type)
                    ? SIGNAL_COLORS[type] || "text-zinc-400 ring-white/10"
                    : "text-zinc-500 ring-white/5 hover:ring-white/10 hover:text-zinc-400"
                }`}
              >
                {type.replace("_", " ")} ({signalTypeCounts[type]})
              </button>
            ))}

            <div className="h-3 w-px bg-white/10 mx-1" />

            {/* VIP toggle */}
            <button
              onClick={() => setVipOnly(!vipOnly)}
              className={`text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset transition-colors ${
                vipOnly
                  ? "bg-accent/10 text-accent-bright ring-accent/20"
                  : "text-zinc-500 ring-white/5 hover:ring-white/10 hover:text-zinc-400"
              }`}
            >
              VIP only
            </button>

            {/* Action filter */}
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value as ActionFilter)}
              className="text-[11px] px-2 py-1 rounded-full bg-surface-overlay border border-white/5
                       text-zinc-400 cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="all">All actions</option>
              <option value="has_action">Has action</option>
              <option value="has_ticket">Has ticket</option>
              <option value="has_pr">Has PR</option>
              <option value="has_draft">Has draft</option>
              <option value="no_action">No action</option>
            </select>

            <div className="h-3 w-px bg-white/10 mx-1" />

            {/* Sort */}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="text-[11px] px-2 py-1 rounded-full bg-surface-overlay border border-white/5
                       text-zinc-400 cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="priority">Sort: Priority</option>
              <option value="newest">Sort: Newest</option>
              <option value="due_date">Sort: Due Date</option>
            </select>

            {/* Clear filters */}
            {hasActiveFilters && (
              <button
                onClick={() => {
                  setChannelFilter("all");
                  setSignalTypeFilter(new Set());
                  setVipOnly(false);
                  setActionFilter("all");
                }}
                className="text-[11px] text-zinc-500 hover:text-zinc-400 transition-colors ml-1"
              >
                Clear
              </button>
            )}
          </div>

          {/* Keyboard Hints */}
          <div className="flex items-center justify-end">
            <div className="text-xs text-zinc-500">
              <Kbd>j</Kbd><Kbd>k</Kbd>
              <span className="ml-1.5">navigate</span>
              <Kbd className="ml-3">o</Kbd>
              <span className="ml-1.5">expand</span>
              <Kbd className="ml-3">r</Kbd>
              <span className="ml-1.5">resolve</span>
              <Kbd className="ml-3">a</Kbd>
              <span className="ml-1.5">archive</span>
            </div>
          </div>

          {/* Filtered empty state */}
          {sorted.length === 0 && hasActiveFilters && (
            <div className="bg-surface-raised rounded-lg border border-white/5 py-8 text-center">
              <p className="text-sm text-zinc-500">No signals match the current filters.</p>
              <button
                onClick={() => {
                  setChannelFilter("all");
                  setSignalTypeFilter(new Set());
                  setVipOnly(false);
                  setActionFilter("all");
                }}
                className="text-sm text-accent-bright hover:underline mt-2"
              >
                Clear filters
              </button>
            </div>
          )}

          {/* Feed List */}
          <div ref={listRef} className="space-y-2">
            {sorted.map((item, index) => (
              <SignalCard
                key={item.message_id}
                item={item}
                index={index}
                isFocused={focusIndex === index}
                isExpanded={expandedId === item.message_id}
                onToggleExpand={() =>
                  setExpandedId((prev) =>
                    prev === item.message_id ? null : item.message_id
                  )
                }
                onResolve={() => resolveMessage(item.message_id)}
                onArchive={() => archiveMessage(item.message_id)}
                onFeedback={submitFeedback}
                feedback={feedback}
              />
            ))}
          </div>

          {/* Contacts & Topics (collapsible) */}
          {(contacts.length > 0 || topics.length > 0) && (
            <section className="border-t border-white/5 pt-4">
              <button
                onClick={() => setShowRelationships(!showRelationships)}
                className="flex items-center gap-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showRelationships ? "rotate-90" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Contacts & Topics
                <span className="text-xs text-zinc-500">
                  {contacts.length} contacts, {topics.length} topics
                </span>
              </button>

              {showRelationships && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
                  {/* Contacts */}
                  <div className="bg-surface-raised rounded-lg border border-white/5 divide-y divide-white/5">
                    <div className="px-4 py-2 text-xs uppercase tracking-wider text-zinc-500 font-medium">
                      Top Contacts
                    </div>
                    {contacts.map((c) => (
                      <div key={c.id} className="px-4 py-2.5 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          {c.is_vip && (
                            <span className="text-[10px] bg-accent/10 text-accent-bright px-1.5 py-0.5 rounded">
                              VIP
                            </span>
                          )}
                          <div>
                            <div className="text-sm font-medium">{c.name || c.email_address}</div>
                            <div className="text-xs text-zinc-500">
                              {c.contact_type} &middot; {c.emails_received} recv, {c.emails_sent} sent
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    {contacts.length === 0 && (
                      <div className="px-4 py-3 text-zinc-500 text-sm">No contacts tracked yet.</div>
                    )}
                  </div>

                  {/* Topics */}
                  <div className="bg-surface-raised rounded-lg border border-white/5 divide-y divide-white/5">
                    <div className="px-4 py-2 text-xs uppercase tracking-wider text-zinc-500 font-medium">
                      Trending Topics
                    </div>
                    {topics.map((t) => (
                      <div key={t.id} className="px-4 py-2.5 flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium">{t.name}</div>
                          <div className="text-xs text-zinc-500">{t.mention_count} mentions</div>
                        </div>
                        <span className={`text-xs ${
                          t.trend_direction === "rising" ? "text-status-approved" : "text-zinc-500"
                        }`}>
                          {t.trend_direction}
                        </span>
                      </div>
                    ))}
                    {topics.length === 0 && (
                      <div className="px-4 py-3 text-zinc-500 text-sm">No topics tracked yet.</div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* Undo Toast */}
      {undoToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-surface-raised border border-white/10 rounded-lg px-4 py-3 shadow-lg flex items-center gap-3">
          <span className="text-sm text-zinc-300">{undoToast.isArchive ? "Message archived" : "Signals resolved"}</span>
          <button
            onClick={undoResolve}
            className="text-sm font-medium text-accent-bright hover:text-accent transition-colors"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signal Card
// ---------------------------------------------------------------------------

function SignalCard({
  item,
  index,
  isFocused,
  isExpanded,
  onToggleExpand,
  onResolve,
  onArchive,
  onFeedback,
  feedback,
}: {
  item: FeedItem;
  index: number;
  isFocused: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onResolve: () => void;
  onArchive: () => void;
  onFeedback: (signalId: string, verdict: "correct" | "incorrect") => void;
  feedback: Record<string, "correct" | "incorrect" | null>;
}) {
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [emailBodyLoading, setEmailBodyLoading] = useState(false);

  // Fetch email body on expand
  useEffect(() => {
    if (isExpanded && emailBody === null && !emailBodyLoading) {
      setEmailBodyLoading(true);
      fetch(`${API_URL}/api/emails/body?id=${encodeURIComponent(item.message_id)}`)
        .then((r) => r.json())
        .then((data) => setEmailBody(data.body || data.snippet || "(No body available)"))
        .catch(() => setEmailBody(item.snippet || "(Failed to load)"))
        .finally(() => setEmailBodyLoading(false));
    }
  }, [isExpanded, emailBody, emailBodyLoading, item.message_id, item.snippet]);

  const actionStatus = getActionStatus(item);
  const displayName = item.contact_name || item.from_name || item.from_address;

  return (
    <div
      data-index={index}
      className={`
        rounded-lg border overflow-hidden transition-all duration-150
        ${isFocused ? "ring-1 ring-accent/40" : ""}
        bg-surface-raised border-white/5
        ${!isFocused ? "hover:border-white/10" : ""}
      `}
    >
      {/* Collapsed Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={onToggleExpand}
      >
        {/* Sender info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <ChannelPill channel={item.channel} webhookSource={item.webhook_source} />
            <span className="text-sm font-medium text-zinc-100 truncate">
              {displayName}
            </span>
            {item.is_vip && (
              <span className="text-[10px] bg-accent/10 text-accent-bright px-1.5 py-0.5 rounded shrink-0">
                VIP
              </span>
            )}
            {item.account_label && (
              <span className="text-[10px] text-zinc-500 shrink-0">via {item.account_label}</span>
            )}
            <span className="text-xs text-zinc-500 shrink-0">
              {timeAgo(item.received_at)}
            </span>
          </div>
          <div className="text-xs text-zinc-400 truncate mt-0.5">
            {item.subject || "(no subject)"}
          </div>
          {/* Inline signal badges */}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {item.signals.map((s) => (
              <SignalPill key={s.id} signal={s} />
            ))}
          </div>
        </div>

        {/* Right side: action pills + resolve */}
        <div className="flex items-center gap-2 shrink-0">
          <ActionPills actions={item.actions} />
          <button
            onClick={(e) => {
              e.stopPropagation();
              onResolve();
            }}
            className="text-[11px] px-2.5 py-1 rounded-md bg-surface-overlay border border-white/5
                     text-zinc-400 hover:text-zinc-200 hover:border-white/15 transition-colors"
            title="Resolve all signals for this message"
          >
            Resolve
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            className="text-[11px] px-2.5 py-1 rounded-md bg-surface-overlay border border-white/5
                     text-zinc-400 hover:text-zinc-200 hover:border-white/15 transition-colors"
            title="Archive message and resolve all signals"
          >
            Archive
          </button>
        </div>
      </div>

      {/* Expanded View */}
      {isExpanded && (
        <div className="border-t border-white/5 px-4 py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left: Original Email */}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
                Original Email
              </div>
              <div className="bg-surface-overlay rounded-lg border border-white/5 p-3 max-h-64 overflow-y-auto">
                {emailBodyLoading ? (
                  <div className="space-y-2">
                    <div className="h-3 w-full bg-white/5 rounded animate-pulse" />
                    <div className="h-3 w-4/5 bg-white/5 rounded animate-pulse" />
                    <div className="h-3 w-3/5 bg-white/5 rounded animate-pulse" />
                  </div>
                ) : (
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                    {emailBody}
                  </pre>
                )}
              </div>
            </div>

            {/* Right: Signals + Draft */}
            <div className="space-y-4">
              {/* Signals detail */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
                  Signals ({item.signals.length})
                </div>
                <div className="space-y-2">
                  {item.signals.map((s) => (
                    <div
                      key={s.id}
                      className="bg-surface-overlay rounded-lg border border-white/5 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <SignalBadge type={s.signal_type} />
                        <span className="text-sm text-zinc-200">{s.content}</span>
                      </div>
                      {s.due_date && (
                        <div className="mt-1">
                          <DueDateLabel dateStr={s.due_date} />
                        </div>
                      )}
                      <div className="flex items-center justify-between mt-1">
                        <div className="text-[10px] text-zinc-500">
                          Confidence: {(Number(s.confidence) * 100).toFixed(0)}%
                        </div>
                        <div className="flex items-center gap-1.5">
                          {feedback[s.id] ? (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              feedback[s.id] === "correct"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-red-500/10 text-red-400"
                            }`}>
                              {feedback[s.id] === "correct" ? "Correct" : "Wrong"}
                            </span>
                          ) : (
                            <>
                              <button
                                onClick={(e) => { e.stopPropagation(); onFeedback(s.id, "correct"); }}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                title="Signal is accurate"
                              >
                                Correct
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onFeedback(s.id, "incorrect"); }}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                                title="Signal is wrong"
                              >
                                Wrong
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action trail */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
                  Actions ({item.actions?.length || 0})
                </div>
                <div className="bg-surface-overlay rounded-lg border border-white/5 px-3 py-2">
                  <ActionDetail item={item} />
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 mt-4 pt-3 border-t border-white/5">
            <button
              onClick={onResolve}
              className="text-sm px-3 py-1.5 rounded-md bg-surface-overlay border border-white/5
                       text-zinc-300 hover:text-zinc-100 hover:border-white/15 transition-colors"
            >
              Resolve All
            </button>
            <button
              onClick={onArchive}
              className="text-sm px-3 py-1.5 rounded-md bg-surface-overlay border border-white/5
                       text-zinc-300 hover:text-zinc-100 hover:border-white/15 transition-colors"
            >
              Archive
            </button>
            {actionStatus === "draft_ready" && (
              <a
                href="/drafts"
                className="text-sm px-3 py-1.5 rounded-md bg-accent/10 border border-accent/20
                         text-accent-bright hover:bg-accent/20 transition-colors"
              >
                Review Draft &rarr;
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SignalBadge({ type }: { type: string }) {
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded ${
        SIGNAL_COLORS[type]?.split(" ring-")[0] || "bg-zinc-700 text-zinc-400"
      }`}
    >
      {type.replace("_", " ")}
    </span>
  );
}

function SignalPill({ signal }: { signal: SignalItem }) {
  const { due_date, signal_type, content } = signal;
  const short = content.length > 40 ? content.slice(0, 40) + "..." : content;
  const isOverdue = due_date && new Date(due_date) < new Date();

  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${
        isOverdue
          ? "bg-status-action/10 text-status-action"
          : SIGNAL_COLORS[signal_type]?.split(" ring-")[0] || "bg-zinc-700 text-zinc-400"
      }`}
      title={content}
    >
      <span className="font-medium">{signal_type.replace("_", " ")}</span>
      <span className="opacity-75">{short}</span>
    </span>
  );
}

function DueDateLabel({ dateStr }: { dateStr: string }) {
  const { text, overdue } = dueLabel(dateStr);
  return (
    <span className={`text-[11px] ${overdue ? "text-status-action font-medium" : "text-status-response"}`}>
      {text}
    </span>
  );
}

type ActionStatusType = "ticket_created" | "pr_created" | "draft_ready" | "draft_sent" | "draft_rejected" | "drafting" | "no_action";

function getActionStatus(item: FeedItem): ActionStatusType {
  if (!item.actions || item.actions.length === 0) return "no_action";
  const pr = item.actions.find(a => a.action_type === "code_fix_pr");
  if (pr) return "pr_created";
  const ticket = item.actions.find(a => a.action_type === "ticket_create");
  if (ticket) return "ticket_created";
  // feedback_receipt and email_draft both show as draft statuses
  const draft = item.actions.find(a => a.action_type === "email_draft" || a.action_type === "feedback_receipt");
  if (!draft) return "no_action";
  if (draft.send_state === "delivered") return "draft_sent";
  if (draft.board_action === "rejected") return "draft_rejected";
  if (draft.reviewer_verdict && !draft.board_action) return "draft_ready";
  return "drafting";
}

function ActionPills({ actions }: { actions: ActionItem[] | null }) {
  if (!actions || actions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-zinc-500">
        <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
        <span className="text-[11px]">No action</span>
      </div>
    );
  }

  const pills: { color: string; label: string }[] = [];
  const hasTicket = actions.some(a => a.action_type === "ticket_create");
  const hasPr = actions.some(a => a.action_type === "code_fix_pr");
  const receipt = actions.find(a => a.action_type === "feedback_receipt");
  const draft = actions.find(a => a.action_type === "email_draft");

  if (hasTicket) pills.push({ color: "bg-purple-500/20 text-purple-400", label: "Ticket" });
  if (hasPr) pills.push({ color: "bg-status-approved/20 text-status-approved", label: "PR" });
  if (receipt) {
    const rLabel = receipt.send_state === "delivered" ? "Receipt sent"
      : receipt.reviewer_verdict && !receipt.board_action ? "Receipt ready"
      : receipt.board_action === "rejected" ? "Receipt rejected"
      : "Receipt";
    pills.push({ color: "bg-emerald-500/20 text-emerald-400", label: rLabel });
  }
  if (draft) {
    const dLabel = draft.send_state === "delivered" ? "Sent"
      : draft.board_action === "rejected" ? "Rejected"
      : draft.reviewer_verdict && !draft.board_action ? "Draft ready"
      : "Drafting...";
    pills.push({ color: "bg-accent/20 text-accent-bright", label: dLabel });
  }

  if (pills.length === 0) {
    pills.push({ color: "bg-zinc-600/20 text-zinc-400", label: "Processing..." });
  }

  return (
    <div className="flex items-center gap-1.5">
      {pills.map((p, i) => (
        <span key={i} className={`text-[10px] px-2 py-0.5 rounded-full ${p.color}`}>
          {p.label}
        </span>
      ))}
    </div>
  );
}

function ActionIndicator({ status }: { status: ActionStatusType }) {
  const config: Record<ActionStatusType, { dot: string; text: string; label: string }> = {
    ticket_created: { dot: "bg-purple-400", text: "text-purple-400", label: "Ticket" },
    pr_created: { dot: "bg-status-approved", text: "text-status-approved", label: "PR" },
    draft_ready: { dot: "bg-status-approved", text: "text-status-approved", label: "Draft ready" },
    draft_sent: { dot: "bg-zinc-500", text: "text-zinc-500", label: "Sent" },
    draft_rejected: { dot: "bg-status-action", text: "text-status-action", label: "Rejected" },
    drafting: { dot: "bg-status-response", text: "text-status-response", label: "Drafting..." },
    no_action: { dot: "bg-zinc-600", text: "text-zinc-500", label: "No action" },
  };
  const c = config[status];
  return (
    <div className={`flex items-center gap-1.5 ${c.text}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      <span className="text-[11px]">{c.label}</span>
    </div>
  );
}

function ActionDetail({ item }: { item: FeedItem }) {
  if (!item.actions || item.actions.length === 0) {
    return <div className="text-sm text-zinc-500">No actions taken yet for this message.</div>;
  }

  return (
    <div className="space-y-2">
      {item.actions.map((action) => (
        <div key={action.id} className="space-y-1">
          {action.action_type === "ticket_create" && (
            <div className="space-y-1">
              <div className="text-sm text-purple-400 font-medium">Ticket created</div>
              <div className="flex items-center gap-2 flex-wrap">
                {action.linear_issue_url && (
                  <a
                    href={action.linear_issue_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent-bright hover:underline"
                  >
                    Linear
                  </a>
                )}
                {action.github_issue_url && (
                  <a
                    href={action.github_issue_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent-bright hover:underline"
                  >
                    GitHub #{action.github_issue_number}
                  </a>
                )}
                {action.target_repo && (
                  <span className="text-[10px] text-zinc-500">{action.target_repo}</span>
                )}
              </div>
            </div>
          )}
          {action.action_type === "code_fix_pr" && (
            <div className="space-y-1">
              <div className="text-sm text-status-approved font-medium">
                PR #{action.github_pr_number}
              </div>
              {action.github_pr_url && (
                <a
                  href={action.github_pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent-bright hover:underline"
                >
                  View on GitHub
                </a>
              )}
            </div>
          )}
          {action.action_type === "feedback_receipt" && (
            <div className="space-y-1.5">
              <div className={`text-sm ${
                action.board_action === "rejected"
                  ? "text-status-action"
                  : action.reviewer_verdict && !action.board_action
                    ? "text-emerald-400"
                    : action.send_state === "delivered"
                      ? "text-zinc-400"
                      : "text-emerald-400/70"
              }`}>
                {action.send_state === "delivered" ? "Feedback receipt sent" :
                 action.board_action === "rejected" ? "Feedback receipt rejected" :
                 action.reviewer_verdict && !action.board_action ? "Feedback receipt ready for review" :
                 "Feedback receipt drafting..."}
              </div>
              {action.email_summary && (
                <div className="text-xs text-zinc-400">
                  <span className="text-zinc-500">Summary:</span> {action.email_summary}
                </div>
              )}
              {action.draft_intent && (
                <div className="text-xs text-emerald-400/80">
                  <span className="text-zinc-500">Intent:</span> {action.draft_intent}
                </div>
              )}
            </div>
          )}
          {action.action_type === "email_draft" && (
            <div className="space-y-1.5">
              <div className={`text-sm ${
                action.board_action === "rejected"
                  ? "text-status-action"
                  : action.reviewer_verdict && !action.board_action
                    ? "text-status-approved"
                    : action.send_state === "delivered"
                      ? "text-zinc-400"
                      : "text-status-response"
              }`}>
                {action.send_state === "delivered" ? "Draft sent" :
                 action.board_action === "rejected" ? "Draft rejected" :
                 action.reviewer_verdict && !action.board_action ? "Draft ready for review" :
                 "Draft in progress..."}
              </div>
              {action.email_summary && (
                <div className="text-xs text-zinc-400">
                  <span className="text-zinc-500">Summary:</span> {action.email_summary}
                </div>
              )}
              {action.draft_intent && (
                <div className="text-xs text-accent-bright/80">
                  <span className="text-zinc-500">Intent:</span> {action.draft_intent}
                </div>
              )}
              {action.tone_score != null && (
                <div className="text-xs text-zinc-400">
                  Tone match: {(Number(action.tone_score) * 100).toFixed(0)}%
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
