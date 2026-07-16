"use client";

import { useEffect, useState, type ReactNode } from "react";
import { inboxGet, timeAgo } from "@/components/inbox/shared";

export type PipelineTimelinePayload = {
  message?: {
    id: string;
    received_at: string;
    triage_category: string | null;
    processed_at: string | null;
    work_item_id: string | null;
    priority_score: number | null;
  };
  work_item?: {
    id: string;
    status: string;
    type: string;
    assigned_to: string | null;
    title: string;
    created_at: string;
  } | null;
  transitions: Array<{
    from_state: string;
    to_state: string;
    agent_id: string;
    reason: string | null;
    created_at: string;
  }>;
  drafts: Array<{
    id: string;
    created_at: string;
    reviewer_verdict: string | null;
    board_action: string | null;
    send_state: string;
    tone_score: string | number | null;
    email_summary: string | null;
  }>;
  error?: string;
};

function formatWhen(iso: string) {
  try {
    const d = new Date(iso);
    return `${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} (${timeAgo(iso)})`;
  } catch {
    return iso;
  }
}

function TimelineRow({
  dotClass,
  title,
  subtitle,
  children,
}: {
  dotClass: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-zinc-200">{title}</div>
        <div className="text-zinc-500">{subtitle}</div>
        {children}
      </div>
    </div>
  );
}

export default function PipelineReplay({
  messageId,
  demoTimeline,
}: {
  messageId: string;
  /** When set, no network requests — for stakeholder demo only. */
  demoTimeline?: PipelineTimelinePayload;
}) {
  const [open, setOpen] = useState(!!demoTimeline);
  const [data, setData] = useState<PipelineTimelinePayload | null>(demoTimeline ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (demoTimeline) {
      setData(demoTimeline);
      return;
    }
    if (!open || !messageId) return;
    setLoading(true);
    setErr(null);
    inboxGet(`/api/pipeline/timeline?message_id=${encodeURIComponent(messageId)}`)
      .then((r) => r.json())
      .then((j: PipelineTimelinePayload) => {
        if (j.error) setErr(String(j.error));
        setData(j);
      })
      .catch(() => setErr("Failed to load timeline"))
      .finally(() => setLoading(false));
  }, [open, messageId, demoTimeline]);

  return (
    <div className="border-b border-white/5 bg-surface-overlay/20">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2 flex items-center justify-between text-left text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.02] transition-colors"
      >
        <span className="inline-flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Pipeline replay
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-3 max-h-56 overflow-y-auto">
          {loading && <p className="text-xs text-zinc-500">Loading…</p>}
          {err && !loading && <p className="text-xs text-red-400">{err}</p>}
          {!loading && !err && data?.message && (
            <div className="space-y-3 text-xs text-zinc-300">
              <TimelineRow dotClass="bg-emerald-500" title="Received" subtitle={formatWhen(data.message.received_at)}>
                {data.message.triage_category && (
                  <div className="text-zinc-400 mt-0.5">
                    Triage: {data.message.triage_category.replace(/_/g, " ")}
                    {data.message.priority_score != null && ` · priority ${data.message.priority_score}`}
                  </div>
                )}
              </TimelineRow>

              {data.message.processed_at && (
                <TimelineRow dotClass="bg-zinc-500" title="Processed" subtitle={formatWhen(data.message.processed_at)} />
              )}

              {data.work_item && (
                <TimelineRow dotClass="bg-accent" title={`Work item · ${data.work_item.type}`} subtitle={data.work_item.status.replace(/_/g, " ")}>
                  <div className="text-zinc-400 truncate">{data.work_item.title}</div>
                </TimelineRow>
              )}

              {data.transitions?.map((t, i) => (
                <TimelineRow
                  key={`${t.created_at}-${i}`}
                  dotClass="bg-zinc-600"
                  title={`${t.from_state} → ${t.to_state}`}
                  subtitle={formatWhen(t.created_at)}
                >
                  {t.reason ? <div className="text-zinc-600 italic mt-0.5">{t.reason}</div> : null}
                </TimelineRow>
              ))}

              {data.drafts?.map((d) => {
                const tone =
                  d.tone_score != null && d.tone_score !== ""
                    ? `${Math.round(Number(d.tone_score) * 100)}% tone`
                    : null;
                const meta = [d.reviewer_verdict && `reviewer: ${d.reviewer_verdict}`, d.board_action && `board: ${d.board_action}`, `send: ${d.send_state}`, tone]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <TimelineRow key={d.id} dotClass="bg-blue-500/90" title="Draft" subtitle={formatWhen(d.created_at)}>
                    {meta && <div className="text-zinc-400 mt-0.5">{meta}</div>}
                    {d.email_summary && <div className="text-zinc-600 mt-1 line-clamp-2">{d.email_summary}</div>}
                  </TimelineRow>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
