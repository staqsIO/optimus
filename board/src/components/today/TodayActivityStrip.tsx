"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { inboxGet } from "@/components/inbox/shared";

type BriefingStats = {
  emails_received_today?: number;
  emails_triaged_today?: number;
  drafts_created_today?: number;
  drafts_awaiting_review?: number;
  action_required_today?: number;
};

type BriefingPayload = {
  stats: BriefingStats | null;
  pendingDrafts?: unknown[];
  actionEmails?: unknown[];
};

export default function TodayActivityStrip() {
  const [data, setData] = useState<BriefingPayload | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await inboxGet("/api/briefing", { signal: AbortSignal.timeout(8000) });
      const json = (await res.json()) as BriefingPayload;
      setData(json);
    } catch {
      setData(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data?.stats) return null;

  const s = data.stats;
  const triaged = s.emails_triaged_today ?? 0;
  const received = s.emails_received_today ?? 0;
  const draftsMade = s.drafts_created_today ?? 0;
  const awaiting = s.drafts_awaiting_review ?? 0;
  const actionToday = s.action_required_today ?? 0;
  const pending = Array.isArray(data.pendingDrafts) ? data.pendingDrafts.length : 0;
  const cold = Array.isArray(data.actionEmails) ? data.actionEmails.length : 0;

  return (
    <div className="rounded-xl border border-white/5 bg-gradient-to-r from-zinc-900/80 to-zinc-900/40 px-4 py-3 mb-2">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Pipeline today</div>
          <p className="text-sm text-zinc-300">
            <span className="text-zinc-100 font-medium">{received}</span> received ·{" "}
            <span className="text-zinc-100 font-medium">{triaged}</span> triaged ·{" "}
            <span className="text-zinc-100 font-medium">{draftsMade}</span> drafts created
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {awaiting > 0 && (
            <Link
              href="/drafts"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/25 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 transition-colors"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {awaiting} draft{awaiting === 1 ? "" : "s"} need you
            </Link>
          )}
          {(actionToday > 0 || cold > 0) && (
            <span className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1">
              {actionToday > 0 && (
                <span>
                  {actionToday} action-required today
                  {cold > 0 ? " · " : ""}
                </span>
              )}
              {cold > 0 && <span>{cold} waiting for first draft</span>}
            </span>
          )}
        </div>
      </div>
      <p className="text-[11px] text-zinc-500 mt-2">
        Agents keep polling — numbers refresh about once a minute here. Urgent human-in-the-loop items still show in Action Required above.
      </p>
    </div>
  );
}
