"use client";

import { useState, useEffect, useCallback } from "react";

interface Intent {
  id: string;
  agent_id: string;
  agent_tier: string;
  intent_type: string;
  decision_tier: string;
  title: string;
  reasoning: string;
  proposed_action: Record<string, unknown>;
  trigger_context: Record<string, unknown> | null;
  trigger_type: string;
  status: string;
  board_feedback: string | null;
  expires_at: string | null;
  created_at: string;
  reviewed_at?: string;
}

interface MatchRate {
  agent_id: string;
  intent_type: string;
  approved: number;
  rejected: number;
  total: number;
  match_rate: string | null;
}

const TIER_STYLES: Record<string, string> = {
  existential: "bg-red-500/20 text-red-300 border-red-500/30",
  strategic: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  tactical: "bg-blue-500/20 text-blue-300 border-blue-500/30",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
  approved: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  rejected: "bg-red-500/20 text-red-300 border-red-500/30",
  executed: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  expired: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function timeRemaining(dateStr: string | null): string {
  if (!dateStr) return "no expiry";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.floor(diff / 60000)}m left`;
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export default function AgentIntents() {
  const [tab, setTab] = useState<"pending" | "history" | "rates">("pending");
  const [pending, setPending] = useState<Intent[]>([]);
  const [history, setHistory] = useState<Intent[]>([]);
  const [rates, setRates] = useState<MatchRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [feedbackInput, setFeedbackInput] = useState<Record<string, string>>({});
  const [showRejectFor, setShowRejectFor] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [pendingRes, historyRes, ratesRes] = await Promise.all([
        fetch("/api/governance/intents?status=pending"),
        fetch("/api/governance/intents?status=history"),
        fetch("/api/governance/intents?status=rates"),
      ]);

      if (!pendingRes.ok) throw new Error("Failed to fetch pending intents");
      const pendingData = await pendingRes.json();
      setPending(pendingData.intents || []);

      if (historyRes.ok) {
        const historyData = await historyRes.json();
        setHistory(historyData.intents || []);
      }

      if (ratesRes.ok) {
        const ratesData = await ratesRes.json();
        setRates(ratesData.rates || []);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleApprove = useCallback(async (id: string) => {
    setActingId(id);
    try {
      const res = await fetch(`/api/governance/intents?id=${encodeURIComponent(id)}&action=approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActingId(null);
    }
  }, [fetchData]);

  const handleReject = useCallback(async (id: string) => {
    setActingId(id);
    try {
      const feedback = feedbackInput[id] || undefined;
      const res = await fetch(`/api/governance/intents?id=${encodeURIComponent(id)}&action=reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      setShowRejectFor(null);
      setFeedbackInput((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActingId(null);
    }
  }, [feedbackInput, fetchData]);

  const tabs = [
    { key: "pending" as const, label: "Pending", count: pending.length },
    { key: "history" as const, label: "History", count: history.length },
    { key: "rates" as const, label: "Rates", count: rates.length },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors whitespace-nowrap ${
              tab === t.key
                ? "bg-accent-bright/20 text-accent-bright border-accent-bright/30"
                : "bg-white/[0.03] text-zinc-500 border-white/5 hover:bg-white/[0.06] hover:text-zinc-400"
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-center py-8 text-zinc-500 text-sm">Loading intents...</div>
      )}

      {/* Pending tab */}
      {!loading && tab === "pending" && (
        pending.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <p className="text-sm">No pending intents</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((intent) => (
              <IntentCard
                key={intent.id}
                intent={intent}
                actingId={actingId}
                showRejectFor={showRejectFor}
                feedbackInput={feedbackInput}
                onApprove={handleApprove}
                onReject={handleReject}
                onShowReject={setShowRejectFor}
                onFeedbackChange={(id, val) => setFeedbackInput((prev) => ({ ...prev, [id]: val }))}
              />
            ))}
          </div>
        )
      )}

      {/* History tab */}
      {!loading && tab === "history" && (
        history.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <p className="text-sm">No intent history yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((intent) => (
              <div
                key={intent.id}
                className="px-4 py-3 rounded-lg border bg-white/[0.02] border-white/5"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-flex px-2 py-0.5 text-[10px] rounded-full border ${STATUS_STYLES[intent.status] || STATUS_STYLES.pending}`}>
                    {intent.status}
                  </span>
                  <span className={`inline-flex px-2 py-0.5 text-[10px] rounded-full border ${TIER_STYLES[intent.decision_tier] || TIER_STYLES.tactical}`}>
                    {intent.decision_tier}
                  </span>
                  <span className="text-[10px] text-zinc-500">{intent.agent_id}</span>
                </div>
                <p className="text-sm text-zinc-200">{intent.title}</p>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                  <span>{intent.intent_type}</span>
                  <span>{timeAgo(intent.reviewed_at || intent.created_at)}</span>
                </div>
                {intent.board_feedback && (
                  <p className="mt-1 text-[11px] text-zinc-400 italic">Feedback: {intent.board_feedback}</p>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* Rates tab */}
      {!loading && tab === "rates" && (
        rates.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <p className="text-sm">No intent data yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-zinc-500 border-b border-white/5">
                  <th className="pb-2 pr-4">Agent</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Rate</th>
                  <th className="pb-2 pr-4">Approved</th>
                  <th className="pb-2 pr-4">Rejected</th>
                  <th className="pb-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((row, i) => {
                  const rate = parseFloat(row.match_rate || "0");
                  const rateColor = rate >= 0.8
                    ? "text-emerald-400"
                    : rate >= 0.5
                    ? "text-yellow-400"
                    : "text-red-400";
                  return (
                    <tr key={i} className="border-b border-white/[0.03]">
                      <td className="py-2 pr-4 text-zinc-300">{row.agent_id}</td>
                      <td className="py-2 pr-4 text-zinc-500">{row.intent_type}</td>
                      <td className={`py-2 pr-4 font-medium ${rateColor}`}>
                        {(rate * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 pr-4 text-zinc-400">{row.approved}</td>
                      <td className="py-2 pr-4 text-zinc-400">{row.rejected}</td>
                      <td className="py-2 text-zinc-400">{row.total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function IntentCard({
  intent,
  actingId,
  showRejectFor,
  feedbackInput,
  onApprove,
  onReject,
  onShowReject,
  onFeedbackChange,
}: {
  intent: Intent;
  actingId: string | null;
  showRejectFor: string | null;
  feedbackInput: Record<string, string>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onShowReject: (id: string | null) => void;
  onFeedbackChange: (id: string, val: string) => void;
}) {
  const action = intent.proposed_action as { type?: string; payload?: Record<string, unknown> };

  return (
    <div className="px-4 py-3 rounded-lg border bg-white/[0.02] border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex px-2 py-0.5 text-[10px] rounded-full border ${TIER_STYLES[intent.decision_tier] || TIER_STYLES.tactical}`}>
              {intent.decision_tier}
            </span>
            <span className="text-[10px] text-zinc-500">
              {intent.intent_type} from {intent.agent_id} ({intent.agent_tier})
            </span>
          </div>
          <p className="text-sm text-zinc-200">{intent.title}</p>
          <p className="mt-1 text-[11px] text-zinc-500 line-clamp-2">{intent.reasoning}</p>
          {intent.trigger_context && (
            <TriggerInfo context={intent.trigger_context} />
          )}
          <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
            {action.type && <span>Action: {action.type}</span>}
            {intent.trigger_type !== "once" && <span>Trigger: {intent.trigger_type}</span>}
            <span>{timeAgo(intent.created_at)}</span>
            <span>{timeRemaining(intent.expires_at)}</span>
          </div>
        </div>
        <span className="text-[10px] text-zinc-600 font-mono flex-shrink-0">{intent.id.slice(0, 8)}</span>
      </div>

      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onApprove(intent.id)}
            disabled={actingId === intent.id}
            className="px-3 py-1 text-xs bg-emerald-500/20 text-emerald-300 rounded-full hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
          >
            Approve
          </button>
          <button
            onClick={() => onShowReject(showRejectFor === intent.id ? null : intent.id)}
            disabled={actingId === intent.id}
            className="px-3 py-1 text-xs bg-red-500/20 text-red-300 rounded-full hover:bg-red-500/30 transition-colors disabled:opacity-40"
          >
            Reject
          </button>
        </div>
        {showRejectFor === intent.id && (
          <div className="flex gap-2">
            <textarea
              value={feedbackInput[intent.id] || ""}
              onChange={(e) => onFeedbackChange(intent.id, e.target.value)}
              placeholder="Feedback (optional)..."
              rows={2}
              className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 resize-none"
            />
            <button
              onClick={() => onReject(intent.id)}
              disabled={actingId === intent.id}
              className="px-3 py-1.5 text-xs bg-red-500/20 text-red-300 rounded-full hover:bg-red-500/30 transition-colors disabled:opacity-40 self-end"
            >
              Confirm
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TriggerInfo({ context }: { context: Record<string, unknown> }) {
  const parts: string[] = [];
  if (context.pattern) parts.push(`Pattern: ${context.pattern}`);
  if (context.signal_ids) parts.push(`${(context.signal_ids as string[]).length} related signals`);
  if (context.gate_id) {
    parts.push(`Gate: ${context.gate_id} (${context.parameter}): ${context.current_value} -> ${context.proposed_value}`);
  }
  if (parts.length === 0) return null;
  return (
    <div className="mt-1 text-[11px] text-zinc-500">
      {parts.map((p, i) => <div key={i}>{p}</div>)}
    </div>
  );
}
