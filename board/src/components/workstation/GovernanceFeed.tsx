"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import type { GovernanceFeedItem, GovernanceSummary, AgentCapability } from "./types";

interface Draft {
  id: string;
  body: string;
  subject: string;
  to_addresses: string[];
  email_summary: string;
  draft_intent: string;
  reviewer_verdict: string;
  tone_score: number | null;
  created_at: string;
  emails: {
    from_address: string;
    from_name: string;
    subject: string;
    channel: string;
    account_label: string;
  };
}

interface StrategicDecision {
  id: string;
  proposed_action: string;
  rationale: string;
  decision_type: string;
  recommendation: string;
  confidence: number | null;
  perspective_scores: Record<string, unknown> | null;
  alternatives_rejected: unknown[] | null;
  kill_criteria: unknown[] | null;
  created_at: string;
}

import { getAgentDisplay } from "@/lib/agent-display";

// --- Agent Personas ---
interface AgentPersona {
  name: string;
  role: string;
  initials: string;
  color: string; // tailwind bg class
  textColor: string;
}

function agentPersona(agentId: string): AgentPersona {
  const d = getAgentDisplay(agentId);
  return { name: d.displayName, role: d.displayName, initials: d.initials, color: d.color, textColor: d.textColor };
}

const FEED_TYPE_AGENT: Record<GovernanceFeedItem["feed_type"], string> = {
  draft_review: "executor-responder",
  strategic_decision: "strategist",
  budget_warning: "orchestrator",
  blocked_item: "orchestrator",
  event: "orchestrator",
  agent_intent: "orchestrator", // overridden by metadata.agent_id in getPersona
  intent_executed: "orchestrator",
  learning_insight: "architect",
};

function getPersona(item: GovernanceFeedItem): AgentPersona {
  const agentType = (item.metadata as Record<string, unknown>)?.agent_type as string | undefined;
  if (agentType) return agentPersona(agentType);
  return agentPersona(FEED_TYPE_AGENT[item.feed_type] || "orchestrator");
}

function getActionVerb(item: GovernanceFeedItem): string {
  switch (item.feed_type) {
    case "draft_review": return "drafted a response";
    case "strategic_decision": return "proposed a strategy";
    case "budget_warning": return "flagged a budget concern";
    case "blocked_item": return "hit a blocker";
    case "event": return "logged an event";
    case "agent_intent": return "proposed an action";
    case "intent_executed": return "executed an approved intent";
    case "learning_insight": return "detected a pattern change";
    default: return "posted an update";
  }
}

function AgentAvatar({ persona, size = "sm" }: { persona: AgentPersona; size?: "sm" | "md" }) {
  const sizeClasses = size === "md" ? "w-9 h-9 text-xs" : "w-7 h-7 text-[10px]";
  return (
    <div className={`${sizeClasses} ${persona.color} rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0`}>
      {persona.initials}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const BTN_FOCUS = "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised";

function toneColor(score: number): string {
  if (score >= 0.8) return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
  if (score >= 0.5) return "text-amber-400 bg-amber-400/10 border-amber-400/20";
  return "text-red-400 bg-red-400/10 border-red-400/20";
}

function verdictColor(verdict: string): string {
  if (verdict === "approved") return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
  if (verdict === "rejected") return "text-red-400 bg-red-400/10 border-red-400/20";
  return "text-zinc-400 bg-zinc-400/10 border-zinc-400/20";
}

function recColor(rec: string): string {
  if (rec === "proceed") return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
  if (rec === "reject") return "text-red-400 bg-red-400/10 border-red-400/20";
  if (rec === "escalate") return "text-amber-400 bg-amber-400/10 border-amber-400/20";
  return "text-zinc-400 bg-zinc-400/10 border-zinc-400/20";
}

// --- Pipeline Strip ---
function PipelineStrip({
  items,
  filterAgent,
  onFilterAgent,
}: {
  items: GovernanceFeedItem[];
  filterAgent: string | null;
  onFilterAgent: (agent: string | null) => void;
}) {
  // Count items per agent type
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of items) {
      const agentType = (item.metadata as Record<string, unknown>)?.agent_type as string | undefined;
      const key = agentType || FEED_TYPE_AGENT[item.feed_type] || "orchestrator";
      map[key] = (map[key] || 0) + 1;
    }
    return map;
  }, [items]);

  const activeAgentKeys = Object.keys(counts).filter(key => key !== "board" && counts[key]);

  if (activeAgentKeys.length === 0) return null;

  return (
    <div className="p-3 bg-surface-raised rounded-lg border border-white/5 space-y-2">
      <div className="flex items-center gap-2 overflow-x-auto">
        {activeAgentKeys.map((key, i) => {
          const persona = agentPersona(key);
          return (
          <div key={key} className="flex items-center gap-2 flex-shrink-0">
            {i > 0 && (
              <svg className="w-4 h-3 text-zinc-800 flex-shrink-0" viewBox="0 0 16 12">
                <line x1="0" y1="6" x2="16" y2="6" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
            <button
              onClick={() => onFilterAgent(filterAgent === key ? null : key)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${
                filterAgent === key
                  ? "bg-white/10 ring-1 ring-white/20"
                  : "hover:bg-white/[0.03]"
              }`}
            >
              <AgentAvatar persona={persona} />
              <div className="flex flex-col items-start">
                <span className={`text-[10px] font-medium ${persona.textColor}`}>
                  {persona.name}
                </span>
                <span className="text-[9px] text-zinc-600">{persona.role}</span>
              </div>
              {(counts[key] || 0) > 0 && (
                <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[9px] font-medium bg-white/10 text-zinc-300 rounded-full">
                  {counts[key]}
                </span>
              )}
            </button>
          </div>
          );
        })}
        {filterAgent && (
          <button
            onClick={() => onFilterAgent(null)}
            className="flex-shrink-0 px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Clear filter
          </button>
        )}
      </div>
    </div>
  );
}

// --- Agent Topology Widget ---
function AgentTopology() {
  const [agents, setAgents] = useState<AgentCapability[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function load() {
      const data = await opsFetch<{ agents: AgentCapability[] }>("/api/governance/capabilities");
      if (data?.agents) {
        setAgents(data.agents.filter(a => a.is_active));
        setLoaded(true);
      }
    }
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!loaded || agents.length === 0) return null;

  const successRate = (a: AgentCapability) => {
    const total = (a.completed_7d || 0) + (a.failed_7d || 0);
    return total > 0 ? Math.round((a.completed_7d / total) * 100) : null;
  };

  const healthColor = (pct: number | null) => {
    if (pct === null) return "text-zinc-500";
    if (pct >= 90) return "text-emerald-400";
    if (pct >= 70) return "text-amber-400";
    return "text-red-400";
  };

  const healthBg = (pct: number | null) => {
    if (pct === null) return "bg-zinc-500/10";
    if (pct >= 90) return "bg-emerald-400/10";
    if (pct >= 70) return "bg-amber-400/10";
    return "bg-red-400/10";
  };

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className={`w-full flex items-center justify-between p-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors ${BTN_FOCUS}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span className="font-medium">Agent Topology</span>
          <span className="px-1.5 py-0.5 text-[9px] bg-surface-overlay text-zinc-500 rounded-full">
            {agents.length} active
          </span>
        </div>
        <div className="flex items-center gap-1">
          {agents.map(a => {
            const pct = successRate(a);
            const display = getAgentDisplay(a.agent_id);
            return (
              <div key={a.agent_id} className={`w-2 h-2 rounded-full ${pct === null ? "bg-zinc-600" : pct >= 90 ? "bg-emerald-400" : pct >= 70 ? "bg-amber-400" : "bg-red-400"}`} title={`${display.displayName}: ${pct ?? '?'}%`} />
            );
          })}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {agents.map(a => {
            const persona = agentPersona(a.agent_id);
            const pct = successRate(a);
            return (
              <div key={a.agent_id} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-white/[0.02]">
                <AgentAvatar persona={persona} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium ${persona.textColor}`}>{persona.name}</span>
                    <span className="text-[9px] text-zinc-600">{a.model}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[10px]">
                  {a.active_tasks > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                      {a.active_tasks} active
                    </span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded ${healthBg(pct)} ${healthColor(pct)}`}>
                    {pct !== null ? `${pct}% 7d` : 'no data'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function GovernanceFeed() {
  const [items, setItems] = useState<GovernanceFeedItem[]>([]);
  const [summary, setSummary] = useState<GovernanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const hasLoadedRef = useRef(false);
  const [filterAgent, setFilterAgent] = useState<string | null>(null);

  // Inline expansion state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDraft, setExpandedDraft] = useState<Draft | null>(null);
  const [expandedDecision, setExpandedDecision] = useState<StrategicDecision | null>(null);
  const [expandLoading, setExpandLoading] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);

  const fetchFeed = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    setError("");
    const [feedResult, summaryResult] = await Promise.all([
      opsFetch<{ items: GovernanceFeedItem[] }>("/api/governance/feed"),
      opsFetch<GovernanceSummary>("/api/governance/summary"),
    ]);
    if (!feedResult) {
      setError("Backend offline");
      setLoading(false);
      return;
    }
    setItems(feedResult.items);
    if (summaryResult) setSummary(summaryResult);
    hasLoadedRef.current = true;
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchFeed();
    const interval = setInterval(fetchFeed, 30_000);
    return () => clearInterval(interval);
  }, [fetchFeed]);

  const toggleExpand = useCallback(async (item: GovernanceFeedItem) => {
    if (expandedId === item.id) {
      setExpandedId(null);
      setExpandedDraft(null);
      setExpandedDecision(null);
      setActionError(null);
      return;
    }

    setExpandedId(item.id);
    setExpandedDraft(null);
    setExpandedDecision(null);
    setActionError(null);
    setExpandLoading(true);

    if (item.feed_type === "agent_intent" || item.feed_type === "intent_executed") {
      // All data is in metadata, no fetch needed
      setExpandLoading(false);
      return;
    }

    if (item.feed_type === "draft_review") {
      const data = await opsFetch<{ drafts: Draft[] }>("/api/drafts");
      const match = data?.drafts?.find((d) => d.id === item.id);
      if (match) setExpandedDraft(match);
    } else if (item.feed_type === "strategic_decision") {
      const data = await opsFetch<StrategicDecision>(
        `/api/governance/decision?id=${encodeURIComponent(item.id)}`
      );
      if (data) setExpandedDecision(data);
    }

    setExpandLoading(false);
  }, [expandedId]);

  const handleDraftAction = useCallback(async (id: string, action: "approve" | "reject" | "send") => {
    if (actionInFlight) return;
    setActionInFlight(id);
    setActionError(null);

    const endpoint = action === "approve" ? "/api/drafts/approve"
      : action === "reject" ? "/api/drafts/reject"
      : "/api/drafts/send";

    const result = await opsPost(endpoint, { id });
    setActionInFlight(null);
    if (!result.ok) {
      setActionError(`Failed to ${action}: ${result.error}`);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
    setExpandedId(null);
    setExpandedDraft(null);
    fetchFeed();
  }, [actionInFlight, fetchFeed]);

  const handleDecisionVerdict = useCallback(async (id: string, verdict: "approved" | "rejected" | "modified") => {
    if (actionInFlight) return;
    setActionInFlight(id);
    setActionError(null);

    const result = await opsPost("/api/governance/decide", { id, verdict });
    setActionInFlight(null);
    if (!result.ok) {
      setActionError(`Failed: ${result.error}`);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
    setExpandedId(null);
    setExpandedDecision(null);
    fetchFeed();
  }, [actionInFlight, fetchFeed]);

  // Intent actions
  const [rejectingIntentId, setRejectingIntentId] = useState<string | null>(null);
  const [intentFeedback, setIntentFeedback] = useState("");

  const handleIntentAction = useCallback(async (id: string, action: "approve" | "reject", feedback?: string) => {
    if (actionInFlight) return;
    setActionInFlight(id);
    setActionError(null);

    const endpoint = action === "approve"
      ? `/api/intents/${id}/approve`
      : `/api/intents/${id}/reject`;
    const body = action === "reject" ? { feedback: feedback || null } : undefined;

    const result = await opsPost(endpoint, body);
    setActionInFlight(null);
    if (!result.ok) {
      setActionError(`Failed to ${action}: ${result.error}`);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
    setExpandedId(null);
    setRejectingIntentId(null);
    setIntentFeedback("");
    fetchFeed();
  }, [actionInFlight, fetchFeed]);

  // Apply agent filter (must be before early returns to satisfy Rules of Hooks)
  const filteredItems = useMemo(() => {
    if (!filterAgent) return items;
    return items.filter((item) => {
      const agentType = (item.metadata as Record<string, unknown>)?.agent_type as string | undefined;
      const key = agentType || FEED_TYPE_AGENT[item.feed_type] || "orchestrator";
      return key === filterAgent;
    });
  }, [items, filterAgent]);

  if (error) {
    return (
      <div className="p-5 bg-surface-raised rounded-lg border border-red-500/20 text-center" role="alert">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchFeed}
          className={`mt-3 px-3 py-2 text-xs bg-surface text-zinc-400 rounded-lg hover:text-zinc-200 border border-white/10 ${BTN_FOCUS}`}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading && !hasLoadedRef.current) {
    return (
      <div className="space-y-4">
        {/* Pulse summary skeleton */}
        <div className="p-4 bg-surface-raised rounded-lg border border-white/5 space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-surface-overlay rounded-full animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 bg-surface-overlay rounded animate-pulse" />
              <div className="flex gap-4">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-3 w-16 bg-surface-overlay rounded animate-pulse" />
                ))}
              </div>
            </div>
          </div>
        </div>
        {/* Feed card skeletons */}
        {[1, 2, 3].map((i) => (
          <div key={i} className="p-4 bg-surface-raised rounded-lg border border-white/5 space-y-2">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 bg-surface-overlay rounded-full animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-48 bg-surface-overlay rounded animate-pulse" />
                <div className="h-4 w-2/3 bg-surface-overlay rounded animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Pipeline strip — agent nodes with counts */}
      {items.length > 0 && (
        <PipelineStrip items={items} filterAgent={filterAgent} onFilterAgent={setFilterAgent} />
      )}

      {/* Agent Topology — collapsible capability matrix */}
      <AgentTopology />

      {/* Org Pulse — styled as a company status post */}
      {summary && (
        <div className="p-4 bg-surface-raised rounded-lg border border-white/5 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-accent to-blue-600 rounded-full flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
              OP
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">Optimus</span>
                <span className="text-xs text-zinc-600">org pulse</span>
                {summary.attention_needed > 0 && (
                  <span className="px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-300 rounded-full">
                    {summary.attention_needed} need attention
                  </span>
                )}
              </div>
              <p className="text-sm text-zinc-400 mt-1">{summary.narrative}</p>
              <div className="flex flex-wrap gap-2 text-xs mt-2">
                <span className={`px-2 py-0.5 rounded-full ${
                  summary.budget.pct > 80
                    ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/20"
                    : "bg-surface-overlay text-zinc-400"
                }`}>
                  Budget: {summary.budget.pct}%
                </span>
                <span className={`px-2 py-0.5 rounded-full ${
                  summary.gates.passing < summary.gates.total
                    ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20"
                    : "bg-surface-overlay text-zinc-400"
                }`}>
                  Gates: {summary.gates.passing}/{summary.gates.total}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-surface-overlay text-zinc-400">
                  Drafts: {summary.drafts_pending}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-surface-overlay text-zinc-400">
                  Strategic: {summary.strategic_pending}
                </span>
                <span className={`px-2 py-0.5 rounded-full ${
                  (summary.intents_pending || 0) > 0
                    ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20"
                    : "bg-surface-overlay text-zinc-400"
                }`}>
                  Intents: {summary.intents_pending || 0}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-surface-overlay text-zinc-400">
                  Pipeline: {summary.pipeline_active}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Feed items */}
      {(() => {
        const highRelevance = filteredItems.filter((i) => i.board_relevance >= 50 || i.requires_action);
        const otherActivity = filteredItems.filter((i) => i.board_relevance < 50 && !i.requires_action);

        const renderFeedCard = (item: GovernanceFeedItem, dimmed = false) => {
          const persona = getPersona(item);
          const isExpanded = expandedId === item.id;
          const isActing = actionInFlight === item.id;
          const canExpand = item.feed_type === "draft_review" || item.feed_type === "strategic_decision" || item.feed_type === "agent_intent" || item.feed_type === "intent_executed";

          return (
            <div
              key={item.id}
              className={`bg-surface-raised rounded-lg border border-white/5 transition-all animate-fade-in ${
                isActing ? "opacity-50" : ""
              } ${dimmed ? "opacity-60" : ""}`}
            >
              {/* Social post header */}
              <div
                className={`p-4 space-y-2 ${canExpand ? "cursor-pointer" : ""}`}
                onClick={canExpand ? () => toggleExpand(item) : undefined}
                role={canExpand ? "button" : undefined}
                tabIndex={canExpand ? 0 : undefined}
                onKeyDown={canExpand ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(item); } } : undefined}
              >
                <div className="flex items-start gap-3">
                  <AgentAvatar persona={persona} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-medium ${persona.textColor}`}>
                        {persona.name}
                      </span>
                      <span className="text-xs text-zinc-600">{getActionVerb(item)}</span>
                      <span className="text-xs text-zinc-600">{timeAgo(item.created_at)}</span>
                      {item.requires_action && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-300 rounded-full">
                          needs attention
                        </span>
                      )}
                      {canExpand && (
                        <svg
                          className={`w-3.5 h-3.5 text-zinc-500 transition-transform ml-auto ${isExpanded ? "rotate-180" : ""}`}
                          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      )}
                    </div>
                    <p className="text-sm text-zinc-200 mt-1">{String(item.title ?? "")}</p>
                    {!isExpanded && <p className="text-xs text-zinc-500 mt-0.5">{String(item.summary ?? "")}</p>}
                  </div>
                </div>
              </div>

              {/* Inline expanded: Draft review */}
              {isExpanded && item.feed_type === "draft_review" && (
                <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3 ml-10">
                  {expandLoading && (
                    <div className="space-y-2 animate-pulse">
                      <div className="h-3 bg-surface-overlay rounded w-full" />
                      <div className="h-3 bg-surface-overlay rounded w-4/5" />
                      <div className="h-3 bg-surface-overlay rounded w-2/3" />
                    </div>
                  )}
                  {!expandLoading && expandedDraft && (
                    <>
                      <div className="text-xs text-zinc-500">
                        To: {expandedDraft.to_addresses?.join(", ")}
                        {expandedDraft.emails?.from_name && (
                          <span className="ml-2">From: {String(expandedDraft.emails.from_name ?? "")}</span>
                        )}
                      </div>
                      {expandedDraft.email_summary && (
                        <p className="text-xs text-zinc-400 italic">{String(expandedDraft.email_summary ?? "")}</p>
                      )}
                      <div className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap bg-surface rounded-lg p-3 border border-white/5 max-h-64 overflow-y-auto">
                        {String(expandedDraft.body ?? "")}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {expandedDraft.tone_score != null && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${toneColor(Number(expandedDraft.tone_score))}`}>
                            tone: {Number(expandedDraft.tone_score).toFixed(2)}
                          </span>
                        )}
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${verdictColor(expandedDraft.reviewer_verdict)}`}>
                          {String(expandedDraft.reviewer_verdict ?? "")}
                        </span>
                        {expandedDraft.emails?.channel && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                            {String(expandedDraft.emails.channel ?? "")}
                          </span>
                        )}
                      </div>
                      {actionError && (
                        <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20" role="alert">
                          {actionError}
                        </div>
                      )}
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleDraftAction(item.id, "approve")}
                            disabled={!!actionInFlight}
                            className={`px-3 py-2 text-xs rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors border border-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleDraftAction(item.id, "reject")}
                            disabled={!!actionInFlight}
                            className={`px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                          >
                            Reject
                          </button>
                        </div>
                        <button
                          onClick={() => handleDraftAction(item.id, "send")}
                          disabled={!!actionInFlight}
                          className={`px-4 py-2 text-xs rounded-lg bg-accent text-white hover:bg-accent-dim transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                        >
                          Approve + Send
                        </button>
                      </div>
                    </>
                  )}
                  {!expandLoading && !expandedDraft && (
                    <p className="text-xs text-zinc-500">Draft details unavailable.</p>
                  )}
                </div>
              )}

              {/* Inline expanded: Strategic decision */}
              {isExpanded && item.feed_type === "strategic_decision" && (
                <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3 ml-10">
                  {expandLoading && (
                    <div className="space-y-2 animate-pulse">
                      <div className="h-3 bg-surface-overlay rounded w-full" />
                      <div className="h-3 bg-surface-overlay rounded w-4/5" />
                      <div className="h-3 bg-surface-overlay rounded w-2/3" />
                    </div>
                  )}
                  {!expandLoading && expandedDecision && (
                    <>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${recColor(expandedDecision.recommendation)}`}>
                          rec: {String(expandedDecision.recommendation ?? "")}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                          {String(expandedDecision.decision_type ?? "")}
                        </span>
                        {expandedDecision.confidence != null && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                            confidence: {expandedDecision.confidence}/5
                          </span>
                        )}
                      </div>
                      {expandedDecision.rationale && (
                        <div className="text-xs text-zinc-300 leading-relaxed bg-surface rounded-lg p-3 border border-white/5">
                          <p className="text-[10px] text-zinc-500 uppercase font-medium mb-1">Rationale</p>
                          <p className="whitespace-pre-wrap">{String(expandedDecision.rationale ?? "")}</p>
                        </div>
                      )}
                      {expandedDecision.perspective_scores && (expandedDecision.perspective_scores as Record<string, unknown>).informed_by && (() => {
                        const ib = (expandedDecision.perspective_scores as Record<string, unknown>).informed_by as Record<string, number>;
                        const total = (ib.intent_match_rates || 0) + (ib.recent_outcome_count || 0) + (ib.graph_pattern_count || 0);
                        if (total === 0) return null;
                        return (
                          <div className="text-xs text-indigo-300 bg-indigo-500/10 px-3 py-2 rounded-lg border border-indigo-500/20">
                            <p className="text-[10px] text-indigo-400 uppercase font-medium mb-1">Informed by learning data</p>
                            <div className="flex gap-3">
                              {(ib.intent_match_rates || 0) > 0 && <span>{ib.intent_match_rates} intent rate(s)</span>}
                              {(ib.recent_outcome_count || 0) > 0 && <span>{ib.recent_outcome_count} recent outcome(s)</span>}
                              {(ib.graph_pattern_count || 0) > 0 && <span>{ib.graph_pattern_count} graph pattern(s)</span>}
                            </div>
                          </div>
                        );
                      })()}
                      {expandedDecision.alternatives_rejected && expandedDecision.alternatives_rejected.length > 0 && (
                        <div className="text-xs text-zinc-400">
                          <p className="text-[10px] text-zinc-500 uppercase font-medium mb-1">Alternatives rejected</p>
                          <ul className="list-disc list-inside space-y-0.5">
                            {expandedDecision.alternatives_rejected.map((alt, i) => (
                              <li key={i}>{typeof alt === "string" ? alt : JSON.stringify(alt)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {actionError && (
                        <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20" role="alert">
                          {actionError}
                        </div>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => handleDecisionVerdict(item.id, "approved")}
                          disabled={!!actionInFlight}
                          className={`px-3 py-2 text-xs rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors border border-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleDecisionVerdict(item.id, "rejected")}
                          disabled={!!actionInFlight}
                          className={`px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleDecisionVerdict(item.id, "modified")}
                          disabled={!!actionInFlight}
                          className={`px-3 py-2 text-xs rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors border border-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                        >
                          Modify
                        </button>
                      </div>
                    </>
                  )}
                  {!expandLoading && !expandedDecision && (
                    <p className="text-xs text-zinc-500">Decision details unavailable.</p>
                  )}
                </div>
              )}

              {/* Inline expanded: Agent intent */}
              {/* Inline expanded: Intent executed (traceability) */}
              {isExpanded && item.feed_type === "intent_executed" && (() => {
                const meta = item.metadata as Record<string, unknown>;
                const agentId = String(meta.agent_id || "unknown");
                const intentType = String(meta.intent_type || "task");
                const decisionTier = String(meta.decision_tier || "tactical");
                const proposedAction = (meta.proposed_action || {}) as Record<string, unknown>;
                const resultingWorkItemId = meta.resulting_work_item_id ? String(meta.resulting_work_item_id) : null;
                const approvedAt = meta.approved_at ? String(meta.approved_at) : null;
                const executedAt = meta.executed_at ? String(meta.executed_at) : null;
                const persona = agentPersona(agentId);

                return (
                  <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3 ml-10">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-emerald-500/30 bg-emerald-500/20 text-emerald-300">
                        executed
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                        {intentType}
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                        {decisionTier}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-300 bg-surface rounded-lg p-3 border border-white/5 space-y-2">
                      <div className="flex items-center gap-2 text-zinc-500">
                        <span className={`font-medium ${persona.textColor}`}>{persona.name}</span>
                        <span>proposed</span>
                        <span>{String(proposedAction.type || "action")}</span>
                      </div>
                      {approvedAt && (
                        <div className="flex items-center gap-2 text-zinc-500">
                          <span className="text-emerald-400">Approved</span>
                          <span>{timeAgo(approvedAt)}</span>
                        </div>
                      )}
                      {executedAt && (
                        <div className="flex items-center gap-2 text-zinc-500">
                          <span className="text-blue-400">Executed</span>
                          <span>{timeAgo(executedAt)}</span>
                        </div>
                      )}
                    </div>
                    {resultingWorkItemId && (
                      <div className="text-xs text-cyan-400 bg-cyan-500/10 px-3 py-2 rounded-lg border border-cyan-500/20">
                        Resulting work item: <span className="font-mono">{resultingWorkItemId.slice(0, 8)}</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Inline expanded: Learning insight */}
              {isExpanded && item.feed_type === "learning_insight" && (() => {
                const meta = item.metadata as Record<string, unknown>;
                const insightType = String(meta.insight_type || "unknown");
                const severity = String(meta.severity || "info");
                const metricCurrent = meta.metric_current != null ? Number(meta.metric_current) : null;
                const metricPrior = meta.metric_prior != null ? Number(meta.metric_prior) : null;
                const metricDelta = meta.metric_delta != null ? Number(meta.metric_delta) : null;
                const sampleSize = meta.sample_size != null ? Number(meta.sample_size) : null;

                const severityBadge = severity === "critical"
                  ? "bg-red-500/20 text-red-300 border-red-500/30"
                  : severity === "warning"
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                  : "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";

                return (
                  <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3 ml-10">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${severityBadge}`}>
                        {severity}
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                        {insightType.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-300 leading-relaxed bg-surface rounded-lg p-3 border border-white/5">
                      <p className="whitespace-pre-wrap">{String(item.summary ?? "")}</p>
                    </div>
                    {(metricCurrent != null || metricPrior != null) && (
                      <div className="text-xs text-zinc-400 bg-white/[0.02] px-3 py-2 rounded-lg border border-white/5 space-y-1">
                        <p className="text-[10px] text-zinc-500 uppercase font-medium">Metric change</p>
                        <div className="flex items-center gap-3">
                          {metricPrior != null && (
                            <span>Prior: <span className="text-zinc-300">{metricPrior}</span></span>
                          )}
                          {metricCurrent != null && (
                            <span>Current: <span className="text-zinc-300">{metricCurrent}</span></span>
                          )}
                          {metricDelta != null && (
                            <span>Delta: <span className={metricDelta > 0 ? "text-red-400" : "text-emerald-400"}>{metricDelta > 0 ? "+" : ""}{metricDelta}</span></span>
                          )}
                        </div>
                      </div>
                    )}
                    {sampleSize != null && sampleSize > 0 && (
                      <p className="text-[10px] text-zinc-500">Sample size: {sampleSize}</p>
                    )}
                  </div>
                );
              })()}

              {/* Inline expanded: Agent intent */}
              {isExpanded && item.feed_type === "agent_intent" && (() => {
                const meta = item.metadata as Record<string, unknown>;
                const decisionTier = String(meta.decision_tier || "tactical");
                const intentType = String(meta.intent_type || "task");
                const agentTier = String(meta.agent_tier || "executor");
                const proposedAction = (meta.proposed_action || {}) as Record<string, unknown>;
                const triggerCtx = (meta.trigger_context || {}) as Record<string, unknown>;
                const expiresAt = meta.expires_at ? String(meta.expires_at) : null;
                const isRejecting = rejectingIntentId === item.id;

                const tierBadge = decisionTier === "existential"
                  ? "bg-red-500/20 text-red-300 border-red-500/30"
                  : decisionTier === "strategic"
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                  : "bg-blue-500/20 text-blue-300 border-blue-500/30";

                // Describe proposed action
                let actionDesc = String(proposedAction.type || "unknown");
                if (proposedAction.type === "create_work_item") {
                  const payload = (proposedAction.payload || {}) as Record<string, unknown>;
                  actionDesc = `Create task: "${String(payload.title || item.title)}", assigned to ${String(payload.assigned_to || "unassigned")}`;
                }

                return (
                  <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3 ml-10">
                    {decisionTier === "existential" && (
                      <div className="text-xs bg-red-500/10 text-red-300 px-3 py-2 rounded-lg border border-red-500/20">
                        Existential-tier intent — requires board deliberation before approval.
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${tierBadge}`}>
                        {decisionTier}
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                        {intentType}
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                        {agentTier}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-300 leading-relaxed bg-surface rounded-lg p-3 border border-white/5">
                      <p className="text-[10px] text-zinc-500 uppercase font-medium mb-1">Reasoning</p>
                      <p className="whitespace-pre-wrap">{String(item.summary ?? "")}</p>
                    </div>
                    <div className="text-xs text-cyan-400 bg-cyan-500/10 px-3 py-2 rounded-lg border border-cyan-500/20">
                      {actionDesc}
                    </div>
                    {!!(triggerCtx.gate_id || triggerCtx.parameter) && (
                      <div className="text-xs bg-purple-500/10 text-purple-300 px-3 py-2 rounded-lg border border-purple-500/20">
                        <p className="text-[10px] text-purple-400 uppercase font-medium mb-1">Gate Change</p>
                        <p>{String(triggerCtx.gate_id || "")} ({String(triggerCtx.parameter || "")}): {String(triggerCtx.current_value || "?")} &rarr; {String(triggerCtx.proposed_value || "?")}</p>
                      </div>
                    )}
                    {expiresAt && (
                      <p className="text-[10px] text-zinc-500">
                        Expires: {(() => {
                          const diff = new Date(expiresAt).getTime() - Date.now();
                          if (diff <= 0) return "expired";
                          const hours = Math.floor(diff / 3_600_000);
                          if (hours < 1) return `${Math.floor(diff / 60_000)}m left`;
                          if (hours < 24) return `${hours}h left`;
                          return `${Math.floor(hours / 24)}d left`;
                        })()}
                      </p>
                    )}
                    {actionError && (
                      <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20" role="alert">
                        {actionError}
                      </div>
                    )}
                    {isRejecting ? (
                      <div className="space-y-2">
                        <textarea
                          value={intentFeedback}
                          onChange={(e) => setIntentFeedback(e.target.value)}
                          placeholder="Optional: why are you rejecting this?"
                          className="w-full px-3 py-2 text-xs bg-surface border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-red-500/50 resize-none"
                          rows={2}
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleIntentAction(item.id, "reject", intentFeedback.trim() || undefined)}
                            disabled={!!actionInFlight}
                            className={`px-3 py-1.5 text-xs rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 ${BTN_FOCUS}`}
                          >
                            Confirm Reject
                          </button>
                          <button
                            onClick={() => { setRejectingIntentId(null); setIntentFeedback(""); }}
                            className={`px-3 py-1.5 text-xs rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors ${BTN_FOCUS}`}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => handleIntentAction(item.id, "approve")}
                          disabled={!!actionInFlight}
                          className={`px-3 py-2 text-xs rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors border border-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => setRejectingIntentId(item.id)}
                          disabled={!!actionInFlight}
                          className={`px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        };

        return (
          <>
            {/* Empty state */}
            {items.length === 0 && !loading && (
              <div className="p-8 bg-surface-raised rounded-lg border border-white/5 text-center space-y-4">
                <div className="flex justify-center gap-2">
                  {["orchestrator", "strategist", "executor-triage", "executor-responder", "reviewer", "architect"].map((id) => {
                    const p = agentPersona(id);
                    return <AgentAvatar key={id} persona={p} size="md" />;
                  })}
                </div>
                <p className="text-sm text-zinc-400">All agents are quiet. Nothing needs your attention.</p>
                <p className="text-xs text-zinc-500">Activity will appear here as agents draft responses, propose strategies, or flag issues.</p>
              </div>
            )}

            {/* No high-relevance items but other activity exists */}
            {highRelevance.length === 0 && otherActivity.length > 0 && !loading && (
              <div className="p-6 bg-surface-raised rounded-lg border border-white/5 text-center space-y-2">
                <p className="text-sm text-zinc-300">Nothing needs your attention right now.</p>
                <p className="text-xs text-zinc-500">Background activity is available below.</p>
              </div>
            )}

            {/* High-relevance feed items */}
            {highRelevance.map((item) => renderFeedCard(item, false))}

            {/* Other Activity — collapsible */}
            {otherActivity.length > 0 && (
              <div>
                <button
                  onClick={() => setShowOther((prev) => !prev)}
                  className={`flex items-center gap-2 w-full px-4 py-2.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg hover:bg-surface-raised ${BTN_FOCUS}`}
                >
                  <span className="text-[10px] leading-none">{showOther ? "\u25BC" : "\u25B6"}</span>
                  <span>Other activity</span>
                  <span className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-zinc-500 rounded-full">
                    {otherActivity.length}
                  </span>
                </button>
                {showOther && (
                  <div className="space-y-4 mt-2">
                    {otherActivity.map((item) => renderFeedCard(item, true))}
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}

    </div>
  );
}
