"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { formatTime, formatDate } from "@/lib/format";

/* ───────── Types ───────── */

interface Signal {
  id: string;
  type: string;
  payload: unknown;
  source_agent?: string;
  created_at: string;
}

interface Briefing {
  id: string;
  briefing_date: string;
  summary: string;
  action_items: unknown[];
  signals: unknown[];
  trending_topics: unknown[];
  vip_activity: unknown[];
  emails_received: number;
  emails_triaged: number;
  drafts_created: number;
  drafts_approved: number;
  drafts_edited: number;
  cost_usd: number | string;
  generated_by: string;
  created_at: string;
}

interface BriefingsResponse {
  latest: Briefing | null;
  history: Briefing[];
}

/** Normalize a JSONB column that may arrive as array, JSON string, or null. */
function asList(val: unknown): string[] {
  let arr: unknown = val;
  if (typeof val === "string") {
    try { arr = JSON.parse(val); } catch { return val.trim() ? [val] : []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) =>
      item == null
        ? ""
        : typeof item === "string"
          ? item
          : typeof item === "object"
            ? (item as Record<string, unknown>).text != null
              ? String((item as Record<string, unknown>).text)
              : (item as Record<string, unknown>).title != null
                ? String((item as Record<string, unknown>).title)
                : (item as Record<string, unknown>).description != null
                  ? String((item as Record<string, unknown>).description)
                  : JSON.stringify(item)
            : String(item)
    )
    .filter((s) => s.trim().length > 0);
}

/* ───────── Emit Signal Modal ───────── */

function EmitSignalModal({ onClose, onEmitted }: { onClose: () => void; onEmitted: () => void }) {
  const [type, setType] = useState("");
  const [payloadJson, setPayloadJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSubmit() {
    setError(null);
    if (!type.trim()) { setError("Signal type is required"); return; }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      setError("Invalid JSON payload"); return;
    }

    setSubmitting(true);
    const res = await opsPost("/api/signals", { signal_type: type.trim(), payload });
    setSubmitting(false);

    if (!res.ok) { setError(res.error); return; }
    onEmitted();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-lg p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-200">Emit Signal</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Signal Type</label>
            <input value={type} onChange={(e) => setType(e.target.value)}
              placeholder="e.g. email.received, briefing.daily"
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Payload (JSON)</label>
            <textarea value={payloadJson} onChange={(e) => setPayloadJson(e.target.value)} rows={6}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600" />
          </div>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting}
            className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 transition-colors">
            {submitting ? "Emitting..." : "Emit Signal"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Briefing Card ───────── */

function BriefingSection({ heading, items }: { heading: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">{heading}</h4>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-zinc-300 leading-relaxed flex gap-2">
            <span className="text-zinc-600 select-none">·</span>
            <span className="whitespace-pre-wrap">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BriefingCard({ briefing, defaultOpen }: { briefing: Briefing; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const cost = typeof briefing.cost_usd === "string" ? parseFloat(briefing.cost_usd) : briefing.cost_usd;
  return (
    <div className="border border-white/5 rounded-lg overflow-hidden bg-zinc-900/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="text-zinc-600 text-xs select-none">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-semibold text-zinc-200">{formatDate(briefing.briefing_date)}</span>
        <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          <span>{briefing.emails_triaged} triaged</span>
          <span>{briefing.drafts_created} drafts</span>
          {Number.isFinite(cost) && <span>${cost.toFixed(2)}</span>}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-white/5">
          {briefing.summary?.trim() && (
            <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{briefing.summary}</p>
          )}
          <BriefingSection heading="Action Items" items={asList(briefing.action_items)} />
          <BriefingSection heading="VIP Activity" items={asList(briefing.vip_activity)} />
          <BriefingSection heading="Signals" items={asList(briefing.signals)} />
          <BriefingSection heading="Trending Topics" items={asList(briefing.trending_topics)} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11px] text-zinc-600">
            <span>received {briefing.emails_received}</span>
            <span>triaged {briefing.emails_triaged}</span>
            <span>drafts {briefing.drafts_created}</span>
            <span>approved {briefing.drafts_approved}</span>
            <span>edited {briefing.drafts_edited}</span>
            <span>by {briefing.generated_by}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── Page ───────── */

export default function SignalsPage() {
  const [tab, setTab] = useState<"feed" | "briefings">("feed");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveMode, setLiveMode] = useState(true);
  const [showEmit, setShowEmit] = useState(false);
  const [filterType, setFilterType] = useState("");
  const [filterSince, setFilterSince] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [briefings, setBriefings] = useState<BriefingsResponse>({ latest: null, history: [] });
  const [briefingsLoading, setBriefingsLoading] = useState(true);

  const fetchBriefings = useCallback(async () => {
    try {
      const res = await opsFetch<BriefingsResponse>("/api/signals/briefings?limit=30");
      if (res) setBriefings({ latest: res.latest ?? null, history: res.history ?? [] });
    } finally {
      setBriefingsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "briefings") fetchBriefings();
  }, [tab, fetchBriefings]);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (filterType.trim()) params.set("type", filterType.trim());
      if (filterSince) {
        const d = new Date(filterSince);
        if (!isNaN(d.getTime())) {
          params.set("since", d.toISOString());
        }
      }

      const res = await opsFetch<{ signals: Signal[] }>(`/api/signals?${params.toString()}`);
      if (res?.signals) setSignals(res.signals);
    } finally {
      setLoading(false);
    }
  }, [filterType, filterSince]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (liveMode && tab === "feed") {
      intervalRef.current = setInterval(fetchData, 5000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [liveMode, tab, fetchData]);

  // Unique signal types for display
  const uniqueTypes = [...new Set(signals.map((s) => s.type))].sort();

  return (
    <div className="flex flex-col h-[calc(100vh-49px)] bg-zinc-950 text-zinc-100">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Signals</span>
        <div className="flex items-center gap-1">
          {(["feed", "briefings"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs px-2 py-0.5 rounded capitalize transition-colors
                ${tab === t ? "text-zinc-100 bg-white/10" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {tab === "feed" ? (
            <>
              <button
                onClick={() => setShowEmit(true)}
                className="text-xs px-2 py-0.5 rounded bg-violet-600 text-white hover:bg-violet-500 transition-colors"
              >
                + Emit Signal
              </button>
              <button
                onClick={() => { setLoading(true); fetchData(); }}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                refresh
              </button>
              <button
                onClick={() => setLiveMode(!liveMode)}
                className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded transition-colors
                  ${liveMode ? "text-emerald-400 bg-emerald-500/10" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
                live
              </button>
            </>
          ) : (
            <button
              onClick={() => { setBriefingsLoading(true); fetchBriefings(); }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              refresh
            </button>
          )}
        </div>
      </div>

      {/* Filters (feed only) */}
      {tab === "feed" && (
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5 shrink-0">
        <label className="text-xs text-zinc-500">Type:</label>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-zinc-600"
        >
          <option value="">All types</option>
          {uniqueTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <label className="text-xs text-zinc-500 ml-2">Since:</label>
        <input
          type="datetime-local"
          value={filterSince}
          onChange={(e) => setFilterSince(e.target.value)}
          className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-zinc-600"
        />
        {(filterType || filterSince) && (
          <button
            onClick={() => { setFilterType(""); setFilterSince(""); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            clear filters
          </button>
        )}
      </div>
      )}

      {tab === "feed" ? (
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">Loading signals...</div>
        ) : (
          <section>
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
              Signals ({signals.length})
            </h2>
            {signals.length === 0 ? (
              <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
                No signals found
              </div>
            ) : (
              <div className="border border-white/5 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-zinc-500">
                      <th className="text-left px-3 py-2 font-medium">Type</th>
                      <th className="text-left px-3 py-2 font-medium">Payload</th>
                      <th className="text-left px-3 py-2 font-medium">Source</th>
                      <th className="text-right px-3 py-2 font-medium">Time</th>
                      <th className="text-right px-3 py-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {signals.map((sig) => (
                      <tr key={sig.id} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                        <td className="px-3 py-2 text-cyan-400">{sig.type}</td>
                        <td className="px-3 py-2 text-zinc-400 max-w-xs truncate" title={JSON.stringify(sig.payload)}>
                          {JSON.stringify(sig.payload)?.slice(0, 80)}
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{sig.source_agent || "--"}</td>
                        <td className="px-3 py-2 text-right text-zinc-500">{formatTime(sig.created_at)}</td>
                        <td className="px-3 py-2 text-right text-zinc-500">{formatDate(sig.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
      ) : (
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {briefingsLoading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">Loading briefings...</div>
        ) : !briefings.latest ? (
          <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
            No briefings yet. The architect agent generates a daily briefing once the pipeline has activity.
          </div>
        ) : (
          <>
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
                Latest Briefing
              </h2>
              <BriefingCard briefing={briefings.latest} defaultOpen />
            </section>
            {briefings.history.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">
                  History ({briefings.history.length})
                </h2>
                <div className="space-y-2">
                  {briefings.history.map((b) => (
                    <BriefingCard key={b.id} briefing={b} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      )}

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-white/5 flex items-center gap-4 text-xs text-zinc-700 shrink-0">
        {tab === "feed" ? (
          <>
            <span>{signals.length} signals</span>
            <span>{uniqueTypes.length} types</span>
            {filterType && <span className="text-violet-400">filtered: {filterType}</span>}
          </>
        ) : (
          <span>
            {(briefings.latest ? 1 : 0) + briefings.history.length} briefings
          </span>
        )}
      </div>

      {/* Emit Signal modal */}
      {showEmit && (
        <EmitSignalModal
          onClose={() => setShowEmit(false)}
          onEmitted={() => { setLoading(true); fetchData(); }}
        />
      )}
    </div>
  );
}
