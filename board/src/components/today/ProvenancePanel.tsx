"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { inboxGet } from "@/components/inbox/shared";

// ── Types ──────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  gcal_event_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  hangout_link: string | null;
  start_at: string;
  end_at: string;
  organizer_email: string | null;
  status: string;
}

interface ProvenanceSignal {
  id: string;
  signal_type: string;
  source_adapter: string | null;
  source_meeting_id: string | null;
  origin: string | null;
  project_id: string | null;
  created_at: string;
}

interface ProvenanceTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number | null;
  task_type: string | null;
  linear_issue_id: string | null;
  linear_issue_url: string | null;
  signal_meeting_id: string | null;
  origin: string | null;
  engagement_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProvenanceData {
  meeting_id: string;
  visible: boolean;
  calendar_event: CalendarEvent | null;
  signals: ProvenanceSignal[];
  tasks: ProvenanceTask[];
  tickets: ProvenanceTask[];
  engagements: unknown[];
  drafts: unknown[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const STATUS_COLORS: Record<string, string> = {
  completed:   "text-emerald-400",
  done:        "text-emerald-400",
  in_progress: "text-yellow-400",
  cancelled:   "text-zinc-600",
  canceled:    "text-zinc-600",
};

// ── Section ────────────────────────────────────────────────────────────────

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </span>
      <span className="text-[10px] text-zinc-700 tabular-nums">{count}</span>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex items-center gap-2 my-1 pl-1">
      <div className="w-px h-4 bg-zinc-800 ml-2" />
      <span className="text-[10px] text-zinc-700 font-mono">↓</span>
    </div>
  );
}

// ── ProvenancePanel ────────────────────────────────────────────────────────

interface ProvenancePanelProps {
  /** The source_meeting_id (e.g. tl;dv meeting id = document.source_id). */
  meetingId: string;
  /** Display title shown in the panel header while loading / as context. */
  meetingTitle?: string;
  onClose: () => void;
}

export default function ProvenancePanel({ meetingId, meetingTitle, onClose }: ProvenancePanelProps) {
  const [data, setData] = useState<ProvenanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await inboxGet(
        `/api/provenance/${encodeURIComponent(meetingId)}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      const json: ProvenanceData = await res.json();
      setData(json);
    } catch (e) {
      setError((e as Error).message || "Failed to load provenance");
    }
    setLoading(false);
  }, [meetingId]);

  useEffect(() => { load(); }, [load]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const title = data?.calendar_event?.title || meetingTitle || "Meeting";

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provenance-panel-title"
        className="fixed right-0 top-0 h-full w-[480px] max-w-full bg-zinc-950 border-l border-white/10 z-50 flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              {/* Chain icon */}
              <svg
                aria-hidden="true"
                className="w-3 h-3 text-zinc-500 shrink-0"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M6.5 9.5a2.828 2.828 0 0 0 4 0l2-2a2.828 2.828 0 0 0-4-4l-1 1" />
                <path d="M9.5 6.5a2.828 2.828 0 0 0-4 0l-2 2a2.828 2.828 0 0 0 4 4l1-1" />
              </svg>
              <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
                Provenance
              </span>
            </div>
            {loading ? (
              <div className="h-4 w-48 bg-white/5 rounded animate-pulse" />
            ) : (
              <h2
                id="provenance-panel-title"
                className="text-sm font-semibold text-zinc-100 leading-snug truncate"
              >
                {title}
              </h2>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={load}
              className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors"
              title="Refresh"
              aria-label="Refresh"
            >
              ↻
            </button>
            <button
              onClick={onClose}
              className="text-zinc-600 hover:text-zinc-300 transition-colors text-lg leading-none"
              title="Close (Esc)"
              aria-label="Close panel"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {loading && (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 rounded-lg bg-surface-raised animate-pulse" />
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-zinc-300">Could not load provenance.</p>
              <p className="text-xs text-red-300/70 mt-1 font-mono">{error}</p>
              <button
                onClick={load}
                className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && data && !data.visible && (
            <div className="rounded-lg border border-white/5 bg-surface-raised/40 px-4 py-4 text-center">
              <p className="text-sm text-zinc-400">No traceable provenance for this item.</p>
              <p className="text-xs text-zinc-600 mt-1">
                The meeting may not have been ingested or no work was derived from it.
              </p>
            </div>
          )}

          {!loading && !error && data && data.visible && (
            <>
              {/* ── Meeting / Calendar Event ─────────────────────────── */}
              <div>
                <SectionLabel label="Meeting" count={data.calendar_event ? 1 : 0} />
                {data.calendar_event ? (
                  <div className="rounded-lg border border-white/5 bg-surface-raised/40 px-3 py-2.5 space-y-0.5">
                    <p className="text-sm font-medium text-zinc-100 leading-snug">
                      {data.calendar_event.title}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {fmt(data.calendar_event.start_at)}
                      {data.calendar_event.organizer_email && (
                        <> · <span className="font-mono">{data.calendar_event.organizer_email}</span></>
                      )}
                    </p>
                    {data.calendar_event.hangout_link && (
                      <a
                        href={data.calendar_event.hangout_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent-bright hover:underline"
                      >
                        Join link →
                      </a>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-white/5 bg-surface-raised/40 px-3 py-2.5">
                    <p className="text-sm text-zinc-400">
                      {title}
                    </p>
                    <p className="text-xs text-zinc-600 mt-0.5 font-mono">{meetingId}</p>
                  </div>
                )}
              </div>

              {/* ── Signals ─────────────────────────────────────────── */}
              {data.signals.length > 0 && (
                <>
                  <Connector />
                  <div>
                    <SectionLabel label="Signals" count={data.signals.length} />
                    <ul className="space-y-1.5">
                      {data.signals.map((s) => (
                        <li
                          key={s.id}
                          className="rounded border border-white/5 bg-surface-raised/40 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                              {s.signal_type.replace(/_/g, " ")}
                            </span>
                            {s.source_adapter && (
                              <span className="text-[10px] text-zinc-700">
                                {s.source_adapter}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-zinc-600 mt-0.5 font-mono truncate">
                            {fmtDate(s.created_at)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              {/* ── Tasks ───────────────────────────────────────────── */}
              {data.tasks.length > 0 && (
                <>
                  <Connector />
                  <div>
                    <SectionLabel label="Tasks" count={data.tasks.length} />
                    <ul className="space-y-1.5">
                      {data.tasks.map((t) => (
                        <li
                          key={t.id}
                          className="rounded border border-white/5 bg-surface-raised/40 px-3 py-2"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm text-zinc-200 leading-snug flex-1 min-w-0 truncate">
                              {t.title}
                            </span>
                            <span className={`text-[10px] font-mono shrink-0 ${STATUS_COLORS[t.status] ?? "text-zinc-500"}`}>
                              {t.status.replace(/_/g, " ")}
                            </span>
                          </div>
                          {t.task_type && (
                            <p className="text-[10px] text-zinc-600 mt-0.5 font-mono uppercase tracking-wider">
                              {t.task_type.replace(/_/g, " ")}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              {/* ── Tickets (Linear) ────────────────────────────────── */}
              {data.tickets.length > 0 && (
                <>
                  <Connector />
                  <div>
                    <SectionLabel label="Tickets" count={data.tickets.length} />
                    <ul className="space-y-1.5">
                      {data.tickets.map((t) => (
                        <li
                          key={t.id}
                          className="rounded border border-white/5 bg-surface-raised/40 px-3 py-2"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm text-zinc-200 leading-snug flex-1 min-w-0 truncate">
                              {t.title}
                            </span>
                            <span className={`text-[10px] font-mono shrink-0 ${STATUS_COLORS[t.status] ?? "text-zinc-500"}`}>
                              {t.status.replace(/_/g, " ")}
                            </span>
                          </div>
                          {t.linear_issue_id && t.linear_issue_url ? (
                            <a
                              href={t.linear_issue_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-accent-bright hover:underline font-mono mt-0.5 inline-block"
                            >
                              {t.linear_issue_id} →
                            </a>
                          ) : t.linear_issue_id ? (
                            <span className="text-[11px] text-zinc-600 font-mono mt-0.5 inline-block">
                              {t.linear_issue_id}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              {/* ── Empty chain ──────────────────────────────────────── */}
              {data.signals.length === 0 &&
                data.tasks.length === 0 &&
                data.tickets.length === 0 && (
                <div className="rounded-lg border border-white/5 bg-surface-raised/40 px-4 py-3 text-center">
                  <p className="text-xs text-zinc-500">
                    Meeting found but no downstream signals or tasks yet.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3 text-[10px] text-zinc-700 shrink-0 font-mono">
          {data && data.visible && (
            <>
              <span>{data.signals.length} signal{data.signals.length !== 1 ? "s" : ""}</span>
              <span>{data.tasks.length} task{data.tasks.length !== 1 ? "s" : ""}</span>
              <span>{data.tickets.length} ticket{data.tickets.length !== 1 ? "s" : ""}</span>
            </>
          )}
          <span className="ml-auto truncate max-w-[200px]">{meetingId}</span>
        </div>
      </div>
    </>
  );
}
