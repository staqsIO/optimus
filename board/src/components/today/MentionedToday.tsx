"use client";

import { useEffect, useState } from "react";
import { inboxGet } from "@/components/inbox/shared";

interface Participant {
  email?: string;
  name?: string;
}

interface Mention {
  id: string;
  title: string | null;
  happenedAt: string;
  participants: Participant[] | null;
}

interface BriefResponse {
  mentions?: Mention[];
}

interface Props {
  email: string;
  startIso: string;
  endIso: string;
}

/**
 * MentionedToday — meetings the viewer was *not* in but where they were
 * named in the transcript. Pulls from /api/today/brief which already does
 * the chunk-text search; reuses the cached response.
 */
export default function MentionedToday({ email, startIso, endIso }: Props) {
  const [mentions, setMentions] = useState<Mention[] | null>(null);

  useEffect(() => {
    setMentions(null);
    if (!email) return;
    const params = new URLSearchParams({
      scope: "personal",
      email,
      start_iso: startIso,
      end_iso: endIso,
    });
    inboxGet(`/api/today/brief?${params.toString()}`, { signal: AbortSignal.timeout(15000) })
      .then((r) => r.json())
      .then((d: BriefResponse) => setMentions(d?.mentions ?? []))
      .catch(() => setMentions([]));
  }, [email, startIso, endIso]);

  if (!mentions || mentions.length === 0) return null;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-xs uppercase tracking-wider text-zinc-500">
          Mentioned today
        </h2>
        <span className="text-[10px] text-zinc-600">
          {mentions.length} meeting{mentions.length === 1 ? "" : "s"} you weren&rsquo;t in
        </span>
      </div>
      <ul className="space-y-1.5">
        {mentions.map((m) => {
          const time = new Date(m.happenedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const attendees = Array.isArray(m.participants)
            ? m.participants
                .slice(0, 4)
                .map((p) => p.name || p.email)
                .filter(Boolean)
                .join(", ")
            : "";
          return (
            <li
              key={m.id}
              className="flex items-baseline gap-3 px-3 py-2 rounded bg-surface-raised/40 border-l-2 border-l-cyan-500/50 text-sm text-zinc-300"
            >
              <span className="text-[10px] text-zinc-500 tabular-nums w-12 shrink-0">
                {time}
              </span>
              <span className="flex-1 min-w-0">
                <span className="text-zinc-200">{m.title || "Untitled"}</span>
                {attendees && (
                  <span className="ml-2 text-[11px] text-zinc-500">
                    with {attendees}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
