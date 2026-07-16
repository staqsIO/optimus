"use client";

import { useEffect, useState } from "react";
import { inboxGet } from "@/components/inbox/shared";

interface BriefMeta {
  scope?: "personal" | "org";
  meetings: number;
  mentions?: number;
  obligations: number;
  generatedAt?: string;
  fallback?: boolean;
}

interface BriefResponse {
  brief: string;
  meta: BriefMeta;
}

interface Props {
  scope: "personal" | "org";
  email: string;
  startIso: string;
  endIso: string;
  ownerHandle?: string;
}

/**
 * MorningBrief — LLM-generated 2-4 sentence prose summary above the Today
 * page. Calls /api/today/brief which is cached server-side for 10 min.
 *
 * Caller passes the local-tz "today" window so server doesn't have to guess.
 */
export default function MorningBrief({ scope, email, startIso, endIso, ownerHandle }: Props) {
  const [data, setData] = useState<BriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const params = new URLSearchParams({ scope, start_iso: startIso, end_iso: endIso });
    if (scope === "personal" && email) params.set("email", email);
    if (ownerHandle) params.set("owner", ownerHandle);
    inboxGet(`/api/today/brief?${params.toString()}`, { signal: AbortSignal.timeout(15000) })
      .then((r) => r.json())
      .then((d: BriefResponse) => setData(d))
      .catch((e) => setError(e?.message || "failed to load"));
  }, [scope, email, startIso, endIso, ownerHandle]);

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4 text-sm text-red-300/80">
        Couldn&rsquo;t load brief: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-white/5 bg-surface-raised/40 px-5 py-4 space-y-2">
        <div className="h-3 rounded bg-white/5 animate-pulse w-4/5" />
        <div className="h-3 rounded bg-white/5 animate-pulse w-3/5" />
      </div>
    );
  }

  // Don't render the panel when there's nothing to say — empty header reads
  // as broken. Parent's space-y handles the gap collapse naturally.
  if (!data.brief || !data.brief.trim()) return null;

  const generatedLabel = data.meta?.generatedAt
    ? new Date(data.meta.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className="rounded-xl border border-white/5 bg-gradient-to-br from-violet-500/[0.06] to-cyan-500/[0.04] px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] uppercase tracking-[0.18em] text-violet-300/80 font-semibold">
          Morning Brief
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-400">
          {scope === "org" ? "org-wide" : "personal"}
        </span>
        {data.meta?.fallback && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300/80">
            fallback
          </span>
        )}
        {generatedLabel && (
          <span className="ml-auto text-[10px] text-zinc-600">
            {generatedLabel}
          </span>
        )}
      </div>
      <p className="text-[15px] leading-relaxed text-zinc-200">
        {data.brief}
      </p>
    </div>
  );
}
