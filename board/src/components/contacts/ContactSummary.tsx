"use client";

import { useEffect, useState } from "react";
import { opsPost } from "@/lib/ops-api";
import CitationChips, { type Citation } from "./CitationChips";

interface SearchResponse {
  answer: string | null;
  citations?: Citation[];
  chunks?: unknown[];
  message?: string;
}

interface Props {
  contactId: string;
  contactName: string;
}

const SUMMARY_QUERY =
  "Summarize all recent activity, open threads, commitments, and contracts involving this contact. Lead with the latest material development.";

export default function ContactSummary({ contactId, contactName }: Props) {
  const [data, setData] = useState<SearchResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [synthesizedAt, setSynthesizedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
    setErrorMessage(null);
    setSynthesizedAt(null);

    (async () => {
      const result = await opsPost<SearchResponse>("/api/search", {
        query: SUMMARY_QUERY,
        participantIds: [contactId],
        matchCount: 12,
      });
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
        setSynthesizedAt(new Date());
        setStatus("ready");
      } else {
        // STAQPRO-555: surface the backend's actual error (e.g. a scope/403
        // message) instead of swallowing it into a generic line. The proxy
        // already extracts { error } from the backend envelope.
        setErrorMessage(result.error);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contactId]);

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Snapshot
        </h3>
        {synthesizedAt && (
          <span className="text-[10px] text-zinc-600">
            synthesized {synthesizedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>

      {status === "loading" && (
        <div className="space-y-2">
          <div className="h-3 bg-zinc-800/60 rounded animate-pulse w-3/4" />
          <div className="h-3 bg-zinc-800/60 rounded animate-pulse w-full" />
          <div className="h-3 bg-zinc-800/60 rounded animate-pulse w-5/6" />
        </div>
      )}

      {status === "error" && (
        <p className="text-sm text-zinc-500">
          {errorMessage
            ? errorMessage
            : "Couldn't synthesize a summary right now."}
        </p>
      )}

      {status === "ready" && data?.answer && (
        <>
          <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
            {data.answer}
          </p>
          {data.citations && data.citations.length > 0 && (
            <CitationChips citations={data.citations} />
          )}
        </>
      )}

      {status === "ready" && !data?.answer && (
        <p className="text-sm text-zinc-500">
          {/* STAQPRO-555: the backend returns answer:null with a `message`
              explaining WHY (no docs, weak matches, calendar not configured,
              etc.). Render that useful default instead of the generic
              "no prior context" boilerplate, which masked real diagnostics. */}
          {data?.message
            ? data.message
            : `No prior context indexed for ${contactName} yet. As emails, transcripts, and contracts accumulate, this summary will populate automatically.`}
        </p>
      )}
    </div>
  );
}
