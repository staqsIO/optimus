"use client";

import { useState, useEffect, useCallback } from "react";

interface Decision {
  id: string;
  decision_type: string;
  proposed_action: string;
  rationale: string | null;
  recommendation: string;
  confidence: number;
  created_at: string;
  board_verdict: string | null;
  board_notes: string | null;
  decided_at: string | null;
  outcome: string | null;
  work_item_title: string | null;
}

const TIER_STYLES: Record<string, string> = {
  existential: "bg-red-500/20 text-red-300 border-red-500/30",
  strategic: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  tactical: "bg-blue-500/20 text-blue-300 border-blue-500/30",
};

const VERDICT_STYLES: Record<string, string> = {
  approved: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  rejected: "bg-red-500/20 text-red-300 border-red-500/30",
  modified: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function StrategicDecisions() {
  const [pending, setPending] = useState<Decision[]>([]);
  const [decided, setDecided] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"pending" | "decided">("pending");

  // Per-row action state
  const [actingId, setActingId] = useState<string | null>(null);
  const [notesInput, setNotesInput] = useState<Record<string, string>>({});
  const [reverseInput, setReverseInput] = useState<Record<string, string>>({});
  const [showNotesFor, setShowNotesFor] = useState<string | null>(null);
  const [notesVerdict, setNotesVerdict] = useState<"rejected" | "modified">("modified");
  const [showReverseFor, setShowReverseFor] = useState<string | null>(null);

  const fetchDecisions = useCallback(async () => {
    try {
      const [pendingRes, decidedRes] = await Promise.all([
        fetch("/api/governance/decisions?status=pending"),
        fetch("/api/governance/decisions?status=decided"),
      ]);
      if (!pendingRes.ok || !decidedRes.ok) throw new Error("Failed to fetch decisions");
      const pendingData = await pendingRes.json();
      const decidedData = await decidedRes.json();
      setPending(pendingData.decisions || []);
      setDecided(decidedData.decisions || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDecisions();
    const interval = setInterval(fetchDecisions, 15000);
    return () => clearInterval(interval);
  }, [fetchDecisions]);

  const handleVerdict = useCallback(async (id: string, verdict: "approved" | "rejected" | "modified") => {
    setActingId(id);
    try {
      const notes = notesInput[id] || undefined;
      const res = await fetch(`/api/governance/decisions?id=${encodeURIComponent(id)}&action=verdict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, notes }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      setShowNotesFor(null);
      setNotesInput((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await fetchDecisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActingId(null);
    }
  }, [notesInput, fetchDecisions]);

  const handleReverse = useCallback(async (id: string) => {
    const reason = reverseInput[id];
    if (!reason?.trim()) return;
    setActingId(id);
    try {
      const res = await fetch(`/api/governance/decisions?id=${encodeURIComponent(id)}&action=reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      setShowReverseFor(null);
      setReverseInput((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await fetchDecisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActingId(null);
    }
  }, [reverseInput, fetchDecisions]);

  const tabs = [
    { key: "pending" as const, label: "Pending", count: pending.length },
    { key: "decided" as const, label: "Past Decisions", count: decided.length },
  ];

  const items = tab === "pending" ? pending : decided;

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
        <div className="text-center py-8 text-zinc-500 text-sm">Loading decisions...</div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <p className="text-sm">{tab === "pending" ? "No pending strategic decisions" : "No past decisions"}</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-2">
          {items.map((d) => (
            <div
              key={d.id}
              className="px-4 py-3 rounded-lg border bg-white/[0.02] border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex px-2 py-0.5 text-[10px] rounded-full border ${TIER_STYLES[d.decision_type] || TIER_STYLES.tactical}`}>
                      {d.decision_type}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      confidence {d.confidence}/5
                    </span>
                    {d.board_verdict && (
                      <span className={`inline-flex px-2 py-0.5 text-[10px] rounded-full border ${VERDICT_STYLES[d.board_verdict] || ""}`}>
                        {d.board_verdict}
                      </span>
                    )}
                    {d.outcome === "reversed" && (
                      <span className="inline-flex px-2 py-0.5 text-[10px] rounded-full border bg-purple-500/20 text-purple-300 border-purple-500/30">
                        reversed
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-zinc-200">{d.proposed_action}</p>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                    <span>Recommends: {d.recommendation}</span>
                    {d.work_item_title && <span>WI: {d.work_item_title}</span>}
                    <span>{timeAgo(d.created_at)}</span>
                  </div>
                  {d.rationale && (
                    <p className="mt-1 text-[11px] text-zinc-500 line-clamp-2">{d.rationale}</p>
                  )}
                  {d.board_notes && tab === "decided" && (
                    <p className="mt-1 text-[11px] text-zinc-400 italic">Notes: {d.board_notes}</p>
                  )}
                </div>
              </div>

              {/* Pending: verdict actions */}
              {tab === "pending" && !d.board_verdict && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleVerdict(d.id, "approved")}
                      disabled={actingId === d.id}
                      className="px-3 py-1 text-xs bg-emerald-500/20 text-emerald-300 rounded-full hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => { setNotesVerdict("rejected"); setShowNotesFor(showNotesFor === d.id && notesVerdict === "rejected" ? null : d.id); }}
                      disabled={actingId === d.id}
                      className="px-3 py-1 text-xs bg-red-500/20 text-red-300 rounded-full hover:bg-red-500/30 transition-colors disabled:opacity-40"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => { setNotesVerdict("modified"); setShowNotesFor(showNotesFor === d.id && notesVerdict === "modified" ? null : d.id); }}
                      disabled={actingId === d.id}
                      className="px-3 py-1 text-xs bg-amber-500/20 text-amber-300 rounded-full hover:bg-amber-500/30 transition-colors disabled:opacity-40"
                    >
                      Modify
                    </button>
                  </div>
                  {showNotesFor === d.id && (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={notesInput[d.id] || ""}
                        onChange={(e) => setNotesInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                        placeholder={`Notes (reason for ${notesVerdict === "rejected" ? "rejection" : "modification"})...`}
                        className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                      />
                      <button
                        onClick={() => handleVerdict(d.id, notesVerdict)}
                        disabled={actingId === d.id}
                        className={`px-3 py-1.5 text-xs rounded-full transition-colors disabled:opacity-40 ${
                          notesVerdict === "rejected"
                            ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                            : "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                        }`}
                      >
                        Submit
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Decided: reverse action */}
              {tab === "decided" && d.outcome !== "reversed" && (
                <div className="mt-3 space-y-2">
                  {showReverseFor !== d.id ? (
                    <button
                      onClick={() => setShowReverseFor(d.id)}
                      className="px-3 py-1 text-xs bg-purple-500/20 text-purple-300 rounded-full hover:bg-purple-500/30 transition-colors"
                    >
                      Reverse
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={reverseInput[d.id] || ""}
                        onChange={(e) => setReverseInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                        placeholder="Reason for reversal..."
                        className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                      />
                      <button
                        onClick={() => handleReverse(d.id)}
                        disabled={actingId === d.id || !reverseInput[d.id]?.trim()}
                        className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded-full hover:bg-purple-500/30 transition-colors disabled:opacity-40"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setShowReverseFor(null)}
                        className="px-3 py-1.5 text-xs bg-zinc-700 text-zinc-400 rounded-full hover:bg-zinc-600 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
