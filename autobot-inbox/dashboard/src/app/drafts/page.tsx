"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { timeAgo } from "@/components/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Draft {
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
  };
}

interface PipelineStats {
  emails_received_today: number;
  action_required_today: number;
  drafts_awaiting_review: number;
  cost_today_usd: string;
  drafts_reviewed_14d: number;
  edit_rate_14d_pct: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATE_LABELS: Record<string, string> = {
  G1: "Budget",
  G2: "Legal",
  G3: "Tone",
  G4: "Autonomy",
  G5: "Reversibility",
  G6: "Stakeholder",
  G7: "Precedent",
};

const TRIAGE_COLORS: Record<string, string> = {
  action_required:
    "bg-status-action/10 text-status-action ring-status-action/20",
  needs_response:
    "bg-status-response/10 text-status-response ring-status-response/20",
  fyi: "bg-status-fyi/10 text-status-fyi ring-status-fyi/20",
  noise: "bg-zinc-700/30 text-zinc-400 ring-zinc-600/20",
  pending: "bg-zinc-700/30 text-zinc-500 ring-zinc-600/20",
};

const ALL_GATES = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function DraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [filterTriage, setFilterTriage] = useState<string | null>(null);
  const [filterVerdict, setFilterVerdict] = useState<string | null>(null);
  const [filterSender, setFilterSender] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const listRef = useRef<HTMLDivElement>(null);

  // ---- Data fetching ----

  const fetchDrafts = useCallback(async () => {
    try {
      const [draftsRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/api/drafts`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${API_URL}/api/briefing`, { signal: AbortSignal.timeout(8000) }),
      ]);
      const draftsData = await draftsRes.json();
      const statsData = await statsRes.json();
      setDrafts(draftsData.drafts || []);
      setStats(statsData.stats || null);
    } catch {
      // silent — will retry on interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrafts();
    const interval = setInterval(fetchDrafts, 10000);
    return () => clearInterval(interval);
  }, [fetchDrafts]);

  // ---- Selection ----

  const toggleSelect = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  const selectAll = () => {
    if (selected.size === filteredDrafts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredDrafts.map((d) => d.id)));
    }
  };

  const clearSelection = () => setSelected(new Set());

  // ---- Keyboard navigation ----

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIndex((i) => Math.min(i + 1, filteredDrafts.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "x":
          e.preventDefault();
          if (filteredDrafts[focusIndex]) toggleSelect(filteredDrafts[focusIndex].id);
          break;
        case "Enter":
        case "o":
          e.preventDefault();
          if (filteredDrafts[focusIndex]) {
            setExpandedId((prev) =>
              prev === filteredDrafts[focusIndex].id ? null : filteredDrafts[focusIndex].id,
            );
          }
          break;
        case "Escape":
          e.preventDefault();
          if (expandedId) setExpandedId(null);
          else if (selected.size > 0) clearSelection();
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drafts, focusIndex, expandedId, selected.size, toggleSelect, filterTriage, filterVerdict, filterSender, channelFilter]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusIndex}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusIndex]);

  // ---- Filtering ----

  const filteredDrafts = drafts.filter((d) => {
    if (channelFilter !== "all" && (d.emails?.channel || d.channel || "email") !== channelFilter) return false;
    if (filterTriage && d.emails.triage_category !== filterTriage) return false;
    if (filterVerdict && d.reviewer_verdict !== filterVerdict) return false;
    if (filterSender && d.emails.from_address !== filterSender) return false;
    return true;
  });

  // Unique senders for the sender filter
  const uniqueSenders = Array.from(
    new Map(
      drafts.map((d) => [
        d.emails.from_address,
        d.emails.from_name || d.emails.from_address,
      ]),
    ),
  );

  // Triage category counts
  const triageCounts: Record<string, number> = {};
  for (const d of drafts) {
    const cat = d.emails.triage_category || "pending";
    triageCounts[cat] = (triageCounts[cat] || 0) + 1;
  }

  // Verdict counts
  const verdictCounts: Record<string, number> = {};
  for (const d of drafts) {
    verdictCounts[d.reviewer_verdict] = (verdictCounts[d.reviewer_verdict] || 0) + 1;
  }

  // Channel counts
  const emailCount = drafts.filter((d) => (d.emails?.channel || d.channel || "email") === "email").length;
  const slackCount = drafts.filter((d) => (d.emails?.channel || d.channel || "email") === "slack").length;

  const hasActiveFilters = filterTriage || filterVerdict || filterSender || channelFilter !== "all";

  // ---- Bulk actions ----

  const handleBulkAction = async (action: "send" | "approve" | "reject") => {
    if (selected.size === 0) return;
    setBulkSubmitting(true);
    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/drafts/bulk", body: { ids: Array.from(selected), action } }),
      });
      clearSelection();
      fetchDrafts();
    } finally {
      setBulkSubmitting(false);
    }
  };

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
            <div
              key={i}
              className="h-16 rounded-lg bg-surface-raised animate-pulse"
            />
          ))}
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="h-20 rounded-lg bg-surface-raised animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">
          Draft Review Queue
        </h1>
        <span className="text-sm text-zinc-500 tabular-nums">
          {hasActiveFilters ? `${filteredDrafts.length} of ` : ""}{drafts.length} pending
        </span>
      </div>

      {/* Pipeline Strip */}
      {stats && <PipelineStrip stats={stats} emailCount={emailCount} slackCount={slackCount} />}

      {/* Empty State */}
      {drafts.length === 0 && <EmptyState />}

      {/* Channel Filter Tabs */}
      {drafts.length > 0 && (
        <div className="flex items-center gap-1 border-b border-white/5 pb-0">
          {([
            { key: "all", label: "All", count: drafts.length },
            { key: "email", label: "Email", count: emailCount },
            { key: "slack", label: "Slack", count: slackCount },
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
      )}

      {/* Filters */}
      {drafts.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500 mr-1">Filter</span>

          {/* Triage category pills */}
          {Object.entries(triageCounts).map(([cat, count]) => (
            <button
              key={cat}
              onClick={() => setFilterTriage(filterTriage === cat ? null : cat)}
              className={`text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset transition-colors ${
                filterTriage === cat
                  ? TRIAGE_COLORS[cat] || TRIAGE_COLORS.pending
                  : "text-zinc-500 ring-white/5 hover:ring-white/10 hover:text-zinc-400"
              }`}
            >
              {cat.replace("_", " ")} ({count})
            </button>
          ))}

          <div className="h-3 w-px bg-white/10 mx-1" />

          {/* Verdict pills */}
          {Object.entries(verdictCounts).map(([verdict, count]) => {
            const vColors: Record<string, string> = {
              approved: "bg-status-approved/10 text-status-approved ring-status-approved/20",
              flagged: "bg-status-response/10 text-status-response ring-status-response/20",
              rejected: "bg-status-action/10 text-status-action ring-status-action/20",
            };
            return (
              <button
                key={verdict}
                onClick={() => setFilterVerdict(filterVerdict === verdict ? null : verdict)}
                className={`text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset transition-colors ${
                  filterVerdict === verdict
                    ? vColors[verdict] || "text-zinc-400 ring-white/10"
                    : "text-zinc-500 ring-white/5 hover:ring-white/10 hover:text-zinc-400"
                }`}
              >
                {verdict} ({count})
              </button>
            );
          })}

          {/* Sender filter */}
          {uniqueSenders.length > 1 && (
            <>
              <div className="h-3 w-px bg-white/10 mx-1" />
              <select
                value={filterSender || ""}
                onChange={(e) => setFilterSender(e.target.value || null)}
                className="text-[11px] px-2 py-1 rounded-full bg-surface-overlay border border-white/5
                         text-zinc-400 cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent/30"
              >
                <option value="">All senders</option>
                {uniqueSenders.map(([email, name]) => (
                  <option key={email} value={email}>
                    {name}
                  </option>
                ))}
              </select>
            </>
          )}

          {/* Clear filters */}
          {hasActiveFilters && (
            <button
              onClick={() => {
                setFilterTriage(null);
                setFilterVerdict(null);
                setFilterSender(null);
                setChannelFilter("all");
              }}
              className="text-[11px] text-zinc-500 hover:text-zinc-400 transition-colors ml-1"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Select All + Keyboard Hints */}
      {filteredDrafts.length > 0 && (
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2.5 text-sm text-zinc-400 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={selected.size === filteredDrafts.length && filteredDrafts.length > 0}
              onChange={selectAll}
              className="sr-only peer"
            />
            <div
              className="h-4 w-4 rounded border border-white/15 bg-surface-overlay flex items-center justify-center
                          peer-checked:bg-accent peer-checked:border-accent transition-colors
                          group-hover:border-white/25"
            >
              {selected.size === filteredDrafts.length && filteredDrafts.length > 0 && (
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
              {selected.size > 0 && selected.size < filteredDrafts.length && (
                <div className="h-0.5 w-2 bg-white rounded-full" />
              )}
            </div>
            Select all ({filteredDrafts.length}{hasActiveFilters ? ` of ${drafts.length}` : ""})
          </label>
          <div className="text-xs text-zinc-500">
            <kbd className="px-1.5 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono">
              j
            </kbd>
            <kbd className="px-1.5 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono ml-1">
              k
            </kbd>
            <span className="ml-1.5">navigate</span>
            <kbd className="px-1.5 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono ml-3">
              x
            </kbd>
            <span className="ml-1.5">select</span>
            <kbd className="px-1.5 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono ml-3">
              o
            </kbd>
            <span className="ml-1.5">expand</span>
          </div>
        </div>
      )}

      {/* Filtered empty state */}
      {drafts.length > 0 && filteredDrafts.length === 0 && hasActiveFilters && (
        <div className="bg-surface-raised rounded-lg border border-white/5 py-8 text-center">
          <p className="text-sm text-zinc-500">No drafts match the current filters.</p>
          <button
            onClick={() => {
              setFilterTriage(null);
              setFilterVerdict(null);
              setFilterSender(null);
              setChannelFilter("all");
            }}
            className="text-sm text-accent-bright hover:underline mt-2"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Draft List */}
      <div ref={listRef} className="space-y-2">
        {filteredDrafts.map((draft, index) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            index={index}
            isSelected={selected.has(draft.id)}
            isFocused={focusIndex === index}
            isExpanded={expandedId === draft.id}
            onToggleSelect={() => toggleSelect(draft.id)}
            onToggleExpand={() =>
              setExpandedId((prev) =>
                prev === draft.id ? null : draft.id,
              )
            }
            onAction={fetchDrafts}
          />
        ))}
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <BulkActionBar
          count={selected.size}
          submitting={bulkSubmitting}
          onAction={handleBulkAction}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline Strip
// ---------------------------------------------------------------------------

function PipelineStrip({ stats, emailCount, slackCount }: { stats: PipelineStats; emailCount: number; slackCount: number }) {
  const cost = parseFloat(stats.cost_today_usd || "0");
  const budgetPct = (cost / 20) * 100;
  const l0Progress = Math.min(
    100,
    (Number(stats.drafts_reviewed_14d || 0) / 50) * 100,
  );

  return (
    <div className="grid grid-cols-4 gap-3">
      <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">
          Awaiting Review
        </div>
        <div className="text-lg font-bold tabular-nums">
          {emailCount + slackCount}
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">
          {emailCount} email{emailCount !== 1 ? "s" : ""}
          {slackCount > 0 && (
            <>
              {" "}&middot;{" "}
              {slackCount} Slack
            </>
          )}
        </div>
      </div>

      <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">
          Budget
        </div>
        <div className="flex items-baseline gap-1.5">
          <span
            className={`text-lg font-bold tabular-nums ${
              budgetPct > 80
                ? "text-status-action"
                : budgetPct > 50
                  ? "text-status-response"
                  : "text-zinc-100"
            }`}
          >
            ${cost.toFixed(2)}
          </span>
          <span className="text-xs text-zinc-500">/ $20</span>
        </div>
        <div className="mt-1.5 h-1 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              budgetPct > 80
                ? "bg-status-action"
                : budgetPct > 50
                  ? "bg-status-response"
                  : "bg-accent"
            }`}
            style={{ width: `${Math.min(100, budgetPct)}%` }}
          />
        </div>
      </div>

      <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">
          L0 Progress
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-bold tabular-nums">
            {stats.drafts_reviewed_14d ?? 0}
          </span>
          <span className="text-xs text-zinc-500">/ 50 drafts</span>
        </div>
        <div className="mt-1.5 h-1 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              l0Progress >= 100 ? "bg-status-approved" : "bg-accent"
            }`}
            style={{ width: `${l0Progress}%` }}
          />
        </div>
      </div>

      <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">
          Edit Rate (14d)
        </div>
        <div className="flex items-baseline gap-1.5">
          <span
            className={`text-lg font-bold tabular-nums ${
              parseFloat(stats.edit_rate_14d_pct || "100") <= 10
                ? "text-status-approved"
                : "text-zinc-100"
            }`}
          >
            {stats.edit_rate_14d_pct ?? "--"}%
          </span>
          <span className="text-xs text-zinc-500">target &lt;10%</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draft Card
// ---------------------------------------------------------------------------

function DraftCard({
  draft,
  index,
  isSelected,
  isFocused,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
  onAction,
}: {
  draft: Draft;
  index: number;
  isSelected: boolean;
  isFocused: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onAction: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(draft.body);
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [emailBodyLoading, setEmailBodyLoading] = useState(false);

  const email = draft.emails;
  const gateResults = draft.gate_results ?? {};
  const failedGates = Object.entries(gateResults).filter(
    ([, v]) => !v.passed,
  );
  const hasFlags = failedGates.length > 0;
  const triageClass =
    TRIAGE_COLORS[email.triage_category] || TRIAGE_COLORS.pending;

  // Fetch original email body when expanded
  useEffect(() => {
    if (isExpanded && emailBody === null && !emailBodyLoading) {
      setEmailBodyLoading(true);
      fetch(`${API_URL}/api/emails/body?id=${encodeURIComponent(draft.message_id)}`)
        .then((r) => r.json())
        .then((data) => {
          setEmailBody(data.body || data.snippet || "(No body available)");
        })
        .catch(() => {
          setEmailBody(email.snippet || "(Failed to load email body)");
        })
        .finally(() => setEmailBodyLoading(false));
    }
  }, [isExpanded, emailBody, emailBodyLoading, draft.message_id, email.snippet]);

  const handleAction = async (action: "approve" | "reject" | "send") => {
    setSubmitting(true);
    try {
      const endpoint =
        action === "send" ? "/api/drafts/send" : `/api/drafts/${action}`;
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: endpoint, body: { id: draft.id } }),
      });
      onAction();
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async () => {
    setSubmitting(true);
    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/drafts/edit", body: { id: draft.id, editedBody } }),
      });
      setEditing(false);
      onAction();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-index={index}
      className={`
        rounded-lg border overflow-hidden transition-all duration-150
        ${isFocused ? "ring-1 ring-accent/40" : ""}
        ${isSelected ? "bg-surface-selected border-accent/20" : "bg-surface-raised border-white/5"}
        ${!isSelected && !isFocused ? "hover:border-white/10" : ""}
      `}
    >
      {/* Collapsed Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={onToggleExpand}
      >
        {/* Checkbox */}
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          className="shrink-0"
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

        {/* Sender + Summary/Intent */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100 truncate">
              {email.from_name || email.from_address}
            </span>
            <ChannelBadge channel={email.channel || draft.channel || "email"} />
            {email.account_label && (
              <span className="text-[10px] text-zinc-500 shrink-0">via {email.account_label}</span>
            )}
            <span className="text-xs text-zinc-500 truncate">
              Re: {email.subject || "(no subject)"}
            </span>
            <span className="text-xs text-zinc-500 shrink-0">
              {timeAgo(email.received_at || draft.created_at)}
            </span>
          </div>
          {draft.email_summary || draft.draft_intent ? (
            <div className="flex items-center gap-1.5 mt-0.5">
              {draft.email_summary && (
                <span className="text-xs text-zinc-400 truncate">
                  <span className="text-zinc-500">asks:</span> {draft.email_summary}
                </span>
              )}
              {draft.email_summary && draft.draft_intent && (
                <span className="text-zinc-700">→</span>
              )}
              {draft.draft_intent && (
                <span className="text-xs text-accent-bright/80 truncate">
                  {draft.draft_intent}
                </span>
              )}
            </div>
          ) : (
            <div className="text-xs text-zinc-500 truncate mt-0.5">
              {email.snippet || "(no preview)"}
            </div>
          )}
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${triageClass}`}
          >
            {email.triage_category?.replace("_", " ") || "pending"}
          </span>

          {draft.tone_score != null && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${
                Number(draft.tone_score) >= 0.8
                  ? "bg-status-approved/10 text-status-approved ring-status-approved/20"
                  : "bg-status-response/10 text-status-response ring-status-response/20"
              }`}
            >
              {(Number(draft.tone_score) * 100).toFixed(0)}%
            </span>
          )}

          <VerdictBadge verdict={draft.reviewer_verdict} hasFlags={hasFlags} />

          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className={`text-zinc-500 transition-transform duration-200 ${
              isExpanded ? "rotate-180" : ""
            }`}
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      {/* Quick Actions (collapsed) */}
      {!isExpanded && (
        <div className="flex items-center gap-1.5 px-4 pb-3 -mt-1">
          <div className="flex-1">
            <div className="flex items-center gap-1">
              {ALL_GATES.map((gate) => {
                const result = gateResults[gate];
                const passed = result?.passed !== false;
                return (
                  <div
                    key={gate}
                    className={`h-1.5 w-1.5 rounded-full ${
                      !result
                        ? "bg-zinc-700"
                        : passed
                          ? "bg-status-approved/60"
                          : "bg-status-action/80"
                    }`}
                    title={`${gate}: ${GATE_LABELS[gate]} - ${!result ? "N/A" : passed ? "passed" : "failed"}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleAction("send");
              }}
              disabled={submitting}
              className="px-3 py-1 text-xs bg-status-approved/10 text-status-approved rounded-md
                       hover:bg-status-approved/20 transition-colors disabled:opacity-50 font-medium"
            >
              Send
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleAction("approve");
              }}
              disabled={submitting}
              className="px-3 py-1 text-xs text-zinc-400 border border-white/10 rounded-md
                       hover:text-zinc-200 hover:border-white/20 transition-colors disabled:opacity-50"
            >
              Draft
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleAction("reject");
              }}
              disabled={submitting}
              className="px-3 py-1 text-xs text-zinc-500 rounded-md
                       hover:text-status-action hover:bg-status-action/10 transition-colors disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Expanded Split View */}
      {isExpanded && (
        <div className="border-t border-white/5 animate-fade-in">
          {/* Summary + Intent strip */}
          {(draft.email_summary || draft.draft_intent) && (
            <div className="px-4 py-2.5 bg-accent/5 border-b border-white/5 flex items-start gap-4">
              {draft.email_summary && (
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] uppercase tracking-wider text-zinc-500">They want</span>
                  <p className="text-sm text-zinc-300 mt-0.5">{draft.email_summary}</p>
                </div>
              )}
              {draft.draft_intent && (
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] uppercase tracking-wider text-zinc-500">Reply does</span>
                  <p className="text-sm text-accent-bright/90 mt-0.5">{draft.draft_intent}</p>
                </div>
              )}
            </div>
          )}

          {/* Gate status bar */}
          <div className="px-4 py-2 bg-surface-overlay/50 flex items-center gap-3 border-b border-white/5">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              Gates
            </span>
            <div className="flex items-center gap-1.5">
              {ALL_GATES.map((gate) => {
                const result = gateResults[gate];
                const passed = result?.passed !== false;
                return (
                  <span
                    key={gate}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      !result
                        ? "bg-zinc-800 text-zinc-500"
                        : passed
                          ? "bg-status-approved/10 text-status-approved"
                          : "bg-status-action/10 text-status-action"
                    }`}
                    title={`${GATE_LABELS[gate]}${result?.detail ? `: ${result.detail}` : ""}`}
                  >
                    {gate}
                  </span>
                );
              })}
            </div>
            {draft.reviewer_notes && (
              <span className="ml-auto text-xs text-zinc-500 italic truncate max-w-[300px]">
                {draft.reviewer_notes}
              </span>
            )}
          </div>

          {/* Split panes */}
          <div className="grid grid-cols-2 divide-x divide-white/5">
            {/* Left: Original Message */}
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs uppercase tracking-wider text-zinc-500">
                      Original {(email.channel || draft.channel || "email") === "slack" ? "Message" : "Email"}
                    </span>
                    <ChannelBadge channel={email.channel || draft.channel || "email"} />
                  </div>
                  <div className="text-sm font-medium text-zinc-200">
                    From: {email.from_name || email.from_address}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {email.from_address}
                    {email.received_at && (
                      <>
                        {" "}
                        &middot;{" "}
                        {new Date(email.received_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </>
                    )}
                  </div>
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${triageClass}`}
                >
                  {email.triage_category?.replace("_", " ") || "pending"}
                </span>
              </div>
              <div className="bg-surface-overlay/50 rounded-lg p-4 max-h-[400px] overflow-y-auto">
                {emailBodyLoading ? (
                  <div className="space-y-2">
                    <div className="h-3 w-full bg-zinc-800 rounded animate-pulse" />
                    <div className="h-3 w-4/5 bg-zinc-800 rounded animate-pulse" />
                    <div className="h-3 w-3/5 bg-zinc-800 rounded animate-pulse" />
                    <div className="h-3 w-full bg-zinc-800 rounded animate-pulse" />
                    <div className="h-3 w-2/3 bg-zinc-800 rounded animate-pulse" />
                  </div>
                ) : (
                  <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                    {emailBody || email.snippet || "(Loading...)"}
                  </pre>
                )}
              </div>
            </div>

            {/* Right: Draft Reply */}
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">
                    AI Draft Reply
                  </div>
                  <div className="text-sm font-medium text-zinc-200">
                    To: {email.from_name || email.from_address}
                  </div>
                  <div className="text-xs text-zinc-500">
                    Re: {email.subject || "(no subject)"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {draft.tone_score != null && (
                    <ToneIndicator score={draft.tone_score} />
                  )}
                  <VerdictBadge
                    verdict={draft.reviewer_verdict}
                    hasFlags={hasFlags}
                  />
                </div>
              </div>

              <div className="bg-surface-overlay/50 rounded-lg p-4 max-h-[400px] overflow-y-auto">
                {editing ? (
                  <textarea
                    className="w-full bg-transparent text-sm text-zinc-200 font-sans
                             resize-y min-h-[200px] focus:outline-none leading-relaxed"
                    value={editedBody}
                    onChange={(e) => setEditedBody(e.target.value)}
                    rows={Math.max(8, editedBody.split("\n").length + 2)}
                    autoFocus
                  />
                ) : (
                  <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                    {draft.body}
                  </pre>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 mt-3">
                {editing ? (
                  <>
                    <button
                      onClick={handleEdit}
                      disabled={submitting || editedBody === draft.body}
                      className="px-4 py-1.5 text-sm bg-accent/15 text-accent-bright rounded-md
                               hover:bg-accent/25 transition-colors disabled:opacity-50 font-medium"
                    >
                      {submitting ? "Saving..." : "Save & Approve"}
                    </button>
                    <button
                      onClick={() => {
                        setEditing(false);
                        setEditedBody(draft.body);
                      }}
                      className="px-4 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => handleAction("send")}
                      disabled={submitting}
                      className="px-4 py-1.5 text-sm bg-status-approved/15 text-status-approved rounded-md
                               hover:bg-status-approved/25 transition-colors disabled:opacity-50 font-medium"
                    >
                      {submitting ? "Sending..." : "Approve & Send"}
                    </button>
                    <button
                      onClick={() => handleAction("approve")}
                      disabled={submitting}
                      className="px-4 py-1.5 text-sm text-zinc-400 border border-white/10 rounded-md
                               hover:text-zinc-200 hover:border-white/20 transition-colors disabled:opacity-50"
                    >
                      Draft Only
                    </button>
                    <button
                      onClick={() => setEditing(true)}
                      className="px-4 py-1.5 text-sm bg-accent/10 text-accent-bright rounded-md
                               hover:bg-accent/20 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleAction("reject")}
                      disabled={submitting}
                      className="px-4 py-1.5 text-sm text-zinc-500 rounded-md
                               hover:text-status-action hover:bg-status-action/10 transition-colors disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verdict Badge
// ---------------------------------------------------------------------------

function VerdictBadge({
  verdict,
  hasFlags,
}: {
  verdict: string;
  hasFlags: boolean;
}) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    approved: {
      bg: "bg-status-approved/10 ring-status-approved/20",
      text: "text-status-approved",
      label: "approved",
    },
    flagged: {
      bg: "bg-status-response/10 ring-status-response/20",
      text: "text-status-response",
      label: "flagged",
    },
    rejected: {
      bg: "bg-status-action/10 ring-status-action/20",
      text: "text-status-action",
      label: "rejected",
    },
  };

  const c = config[verdict] || config.flagged;

  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${c.bg} ${c.text}`}
    >
      {hasFlags && verdict === "approved" ? "approved*" : c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tone Indicator
// ---------------------------------------------------------------------------

function ToneIndicator({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const passing = score >= 0.8;

  return (
    <div
      className="flex items-center gap-1.5"
      title={`Voice tone match: ${pct}%`}
    >
      <div className="w-12 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            passing ? "bg-status-approved" : "bg-status-response"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`text-[11px] tabular-nums font-medium ${
          passing ? "text-status-approved" : "text-status-response"
        }`}
      >
        {pct}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Action Bar
// ---------------------------------------------------------------------------

function BulkActionBar({
  count,
  submitting,
  onAction,
  onClear,
}: {
  count: number;
  submitting: boolean;
  onAction: (action: "send" | "approve" | "reject") => void;
  onClear: () => void;
}) {
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50
                 bg-surface-overlay/95 backdrop-blur-xl border border-white/10
                 rounded-xl px-5 py-3 shadow-2xl shadow-black/40
                 flex items-center gap-4 animate-bulk-bar"
      role="toolbar"
      aria-label="Bulk draft actions"
    >
      <span className="text-sm font-medium text-zinc-200 tabular-nums">
        {count} selected
      </span>
      <div className="h-4 w-px bg-white/10" />
      <button
        onClick={() => onAction("send")}
        disabled={submitting}
        className="px-4 py-1.5 text-sm bg-status-approved/15 text-status-approved rounded-md
                 hover:bg-status-approved/25 transition-colors disabled:opacity-50 font-medium"
      >
        {submitting ? "Processing..." : "Approve & Send All"}
      </button>
      <button
        onClick={() => onAction("approve")}
        disabled={submitting}
        className="px-4 py-1.5 text-sm text-zinc-300 border border-white/10 rounded-md
                 hover:text-white hover:border-white/20 transition-colors disabled:opacity-50"
      >
        Draft Only
      </button>
      <button
        onClick={() => onAction("reject")}
        disabled={submitting}
        className="px-4 py-1.5 text-sm text-zinc-500 rounded-md
                 hover:text-status-action hover:bg-status-action/10 transition-colors disabled:opacity-50"
      >
        Reject All
      </button>
      <div className="h-4 w-px bg-white/10" />
      <button
        onClick={onClear}
        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        Clear
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel Badge
// ---------------------------------------------------------------------------

function ChannelBadge({ channel }: { channel: string }) {
  const isSlack = channel === "slack";
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
        isSlack
          ? "bg-purple-500/20 text-purple-400"
          : "bg-blue-500/20 text-blue-400"
      }`}
    >
      {isSlack ? "# Slack" : "\u2709 Email"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 py-16 px-8 text-center">
      <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-status-approved/10 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-status-approved"
        >
          <path
            d="M9 12l2 2 4-4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="10" />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-zinc-200 mb-1">All caught up</h3>
      <p className="text-sm text-zinc-500 max-w-sm mx-auto">
        No drafts awaiting review. New drafts will appear here as the AI
        processes incoming emails.
      </p>
    </div>
  );
}
