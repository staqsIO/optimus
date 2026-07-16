"use client";

import { useState, useCallback } from "react";
import { useIntents } from "./useIntents";
import type { AgentIntent, IntentMatchRate } from "./types";

import { getAgentDisplay } from "@/lib/agent-display";

interface AgentPersona {
  name: string;
  role: string;
  initials: string;
  color: string;
  textColor: string;
}

function getPersona(agentId: string): AgentPersona {
  const d = getAgentDisplay(agentId);
  return {
    name: d.displayName,
    role: formatAgentId(agentId),
    initials: d.initials,
    color: d.color,
    textColor: d.textColor,
  };
}

function formatAgentId(id: string): string {
  // Extract role from ID: "executor-triage" -> "Triage", "orchestrator" -> "Orchestrator"
  const parts = id.split("-");
  if (parts.length >= 2) return parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function AgentAvatar({ persona }: { persona: AgentPersona }) {
  return (
    <div className={`w-7 h-7 ${persona.color} rounded-full flex items-center justify-center text-white font-semibold text-[10px] flex-shrink-0`}>
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

function timeRemaining(dateStr: string | null): string {
  if (!dateStr) return "no expiry";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `${Math.floor(diff / 60_000)}m left`;
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

const TIER_STYLES: Record<string, { badge: string; border: string }> = {
  existential: {
    badge: "bg-red-500/20 text-red-300 border-red-500/30",
    border: "border-l-red-500",
  },
  strategic: {
    badge: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    border: "border-l-amber-500",
  },
  tactical: {
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    border: "border-l-blue-500",
  },
};

const BTN_FOCUS = "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised";

function describeAction(intent: AgentIntent): string {
  const action = intent.proposed_action;
  if (action.type === "create_work_item") {
    const p = action.payload || {};
    const assignee = (p.assigned_to as string) || "unassigned";
    const title = (p.title as string) || intent.title;
    return `Create task: "${title}", assigned to ${assignee}`;
  }
  if (action.type === "create_schedule") {
    const p = action.payload || {};
    return `Create schedule (${(p.schedule_type as string) || "once"})`;
  }
  if (action.type === "modify_gate") {
    const p = action.payload || {};
    return `Modify gate ${(p.gate_id as string) || "unknown"}`;
  }
  return `${action.type}`;
}

// --- Match Rates Table ---
function MatchRatesTable({ rates }: { rates: IntentMatchRate[] }) {
  if (rates.length === 0) {
    return <p className="text-xs text-zinc-500 py-2">No intent data yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-zinc-500 border-b border-white/5">
            <th className="text-left py-1.5 pr-3 font-medium">Agent</th>
            <th className="text-left py-1.5 pr-3 font-medium">Type</th>
            <th className="text-right py-1.5 pr-3 font-medium">Rate</th>
            <th className="text-right py-1.5 font-medium">Count</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r, i) => {
            const rate = parseFloat(String(r.match_rate || 0));
            const rateColor = rate >= 0.8 ? "text-emerald-400" : rate >= 0.5 ? "text-amber-400" : "text-red-400";
            return (
              <tr key={i} className="border-b border-white/[0.03]">
                <td className="py-1.5 pr-3 text-zinc-300">{r.agent_id}</td>
                <td className="py-1.5 pr-3 text-zinc-400">{r.intent_type}</td>
                <td className={`py-1.5 pr-3 text-right font-medium ${rateColor}`}>
                  {(rate * 100).toFixed(1)}%
                </td>
                <td className="py-1.5 text-right text-zinc-500">{r.total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Intent Card ---
function IntentCard({
  intent,
  onApprove,
  onReject,
  disabled,
}: {
  intent: AgentIntent;
  onApprove: (id: string) => void;
  onReject: (id: string, feedback: string | null) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");

  const persona = getPersona(intent.agent_id);
  const tier = TIER_STYLES[intent.decision_tier] || TIER_STYLES.tactical;
  const isExistential = intent.decision_tier === "existential";
  const ctx = intent.trigger_context || {};

  const handleRejectConfirm = useCallback(() => {
    onReject(intent.id, feedback.trim() || null);
    setRejecting(false);
    setFeedback("");
  }, [intent.id, feedback, onReject]);

  return (
    <div
      className={`bg-surface-raised rounded-lg border border-white/5 transition-all ${
        isExistential ? `border-l-2 ${tier.border}` : ""
      } ${disabled ? "opacity-50" : ""}`}
    >
      {/* Header */}
      <div
        className="p-4 space-y-2 cursor-pointer"
        onClick={() => setExpanded((p) => !p)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((p) => !p); } }}
      >
        <div className="flex items-start gap-3">
          <AgentAvatar persona={persona} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-medium ${persona.textColor}`}>
                {persona.name}
              </span>
              <span className="text-xs text-zinc-600">
                proposed a {intent.intent_type}
              </span>
              <span className="text-xs text-zinc-600">{timeAgo(intent.created_at)}</span>
              <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${tier.badge}`}>
                {intent.decision_tier}
              </span>
              <svg
                className={`w-3.5 h-3.5 text-zinc-500 transition-transform ml-auto ${expanded ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
            <p className="text-sm text-zinc-200 mt-1">{intent.title}</p>
            {!expanded && (
              <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{intent.reasoning}</p>
            )}
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3 ml-10">
          {/* Existential warning */}
          {isExistential && (
            <div className="text-xs bg-red-500/10 text-red-300 px-3 py-2 rounded-lg border border-red-500/20">
              Existential-tier intent — requires board deliberation before approval.
            </div>
          )}

          {/* Reasoning */}
          <div className="text-xs text-zinc-300 leading-relaxed bg-surface rounded-lg p-3 border border-white/5">
            <p className="text-[10px] text-zinc-500 uppercase font-medium mb-1">Reasoning</p>
            <p className="whitespace-pre-wrap">{String(intent.reasoning)}</p>
          </div>

          {/* Proposed action summary */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-cyan-500/20 text-cyan-400 bg-cyan-500/10">
              {describeAction(intent)}
            </span>
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
              {intent.agent_tier}
            </span>
          </div>

          {/* Governance context (gate changes) */}
          {!!(ctx.gate_id || ctx.parameter) && (() => {
            const evidence = ctx.evidence as Record<string, unknown> | undefined;
            return (
              <div className="text-xs bg-purple-500/10 text-purple-300 px-3 py-2 rounded-lg border border-purple-500/20 space-y-1">
                <p className="text-[10px] text-purple-400 uppercase font-medium">Gate Change</p>
                <p>
                  {String(ctx.gate_id || "")} ({String(ctx.parameter || "")}): {String(ctx.current_value || "?")} &rarr; {String(ctx.proposed_value || "?")}
                </p>
                {evidence && (
                  <p className="text-purple-400">
                    Evidence: {String(evidence.total_checked || 0)} checked, {(parseFloat(String(evidence.false_positive_rate || 0)) * 100).toFixed(1)}% false positive rate
                  </p>
                )}
              </div>
            );
          })()}

          {/* Expiry */}
          <p className="text-[10px] text-zinc-500">
            Expires: {timeRemaining(intent.expires_at)}
          </p>

          {/* Reject feedback form */}
          {rejecting ? (
            <div className="space-y-2">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Optional: why are you rejecting this?"
                className="w-full px-3 py-2 text-xs bg-surface border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-red-500/50 resize-none"
                rows={2}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRejectConfirm}
                  disabled={disabled}
                  className={`px-3 py-1.5 text-xs rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 ${BTN_FOCUS}`}
                >
                  Confirm Reject
                </button>
                <button
                  onClick={() => { setRejecting(false); setFeedback(""); }}
                  className={`px-3 py-1.5 text-xs rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors ${BTN_FOCUS}`}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={(e) => { e.stopPropagation(); onApprove(intent.id); }}
                disabled={disabled}
                className={`px-3 py-2 text-xs rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors border border-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
              >
                Approve
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setRejecting(true); }}
                disabled={disabled}
                className={`px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_FOCUS}`}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Main Panel ---
export default function IntentsPanel() {
  const {
    intents,
    rates,
    loading,
    error,
    actionInFlight,
    approveIntent,
    rejectIntent,
    fetchIntents,
    fetchRates,
  } = useIntents();

  const [showRates, setShowRates] = useState(false);
  const [ratesLoaded, setRatesLoaded] = useState(false);

  const handleToggleRates = useCallback(() => {
    if (!ratesLoaded) {
      fetchRates();
      setRatesLoaded(true);
    }
    setShowRates((p) => !p);
  }, [ratesLoaded, fetchRates]);

  // Collapsed header when empty and not loading
  if (!loading && intents.length === 0 && !error) {
    return (
      <div className="p-4 bg-surface-raised rounded-lg border border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">Agent Intents:</span>
            <span className="text-sm text-zinc-500">0 pending</span>
          </div>
          <button
            onClick={handleToggleRates}
            className={`text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors ${BTN_FOCUS}`}
          >
            {showRates ? "Hide" : "Trust"} scores
          </button>
        </div>
        {!showRates && (
          <p className="text-xs text-zinc-600 mt-1">
            No pending intents. Agents are operating within approved scope.
          </p>
        )}
        {showRates && (
          <div className="mt-3">
            <MatchRatesTable rates={rates} />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5 bg-surface-raised rounded-lg border border-red-500/20 text-center" role="alert">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchIntents}
          className={`mt-3 px-3 py-2 text-xs bg-surface text-zinc-400 rounded-lg hover:text-zinc-200 border border-white/10 ${BTN_FOCUS}`}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading && intents.length === 0) {
    return (
      <div className="space-y-3">
        <div className="p-4 bg-surface-raised rounded-lg border border-white/5">
          <div className="h-4 w-48 bg-surface-overlay rounded animate-pulse" />
        </div>
        {[1, 2].map((i) => (
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
    <div className="space-y-3">
      {/* Header */}
      <div className="p-4 bg-surface-raised rounded-lg border border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">Agent Intents</span>
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-300 rounded-full">
              {intents.length} pending
            </span>
          </div>
          <button
            onClick={handleToggleRates}
            className={`text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors ${BTN_FOCUS}`}
          >
            {showRates ? "Hide" : "Trust"} scores
          </button>
        </div>
        {showRates && (
          <div className="mt-3">
            <MatchRatesTable rates={rates} />
          </div>
        )}
      </div>

      {/* Intent cards */}
      {intents.map((intent) => (
        <IntentCard
          key={intent.id}
          intent={intent}
          onApprove={approveIntent}
          onReject={rejectIntent}
          disabled={actionInFlight === intent.id}
        />
      ))}
    </div>
  );
}
