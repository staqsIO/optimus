"use client";

import { useState } from "react";
import { opsPost } from "@/lib/ops-api";
import CitationChips, { type Citation } from "./CitationChips";

interface SearchResponse {
  answer: string | null;
  citations?: Citation[];
  message?: string;
}

interface Props {
  contactId: string;
  contactName: string;
}

type State =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "ready"; query: string; data: SearchResponse }
  | { status: "error"; query: string; error: string };

export default function AskAboutContact({ contactId, contactName }: Props) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit() {
    const query = input.trim();
    if (!query) return;
    setState({ status: "loading", query });

    const result = await opsPost<SearchResponse>("/api/search", {
      query,
      participantIds: [contactId],
      matchCount: 10,
    });

    if (result.ok) {
      setState({ status: "ready", query, data: result.data });
    } else {
      setState({ status: "error", query, error: result.error });
    }
  }

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg p-5">
      <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
        Ask about {contactName}
      </h3>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={`What's the latest with ${contactName}? Pricing? Open commitments?`}
          className="flex-1 bg-zinc-800 border border-white/10 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
          disabled={state.status === "loading"}
        />
        <button
          onClick={handleSubmit}
          disabled={state.status === "loading" || !input.trim()}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition-colors"
        >
          {state.status === "loading" ? "Asking…" : "Ask"}
        </button>
      </div>

      {state.status === "loading" && (
        <div className="mt-4 space-y-2">
          <div className="h-3 bg-zinc-800/60 rounded animate-pulse w-2/3" />
          <div className="h-3 bg-zinc-800/60 rounded animate-pulse w-full" />
        </div>
      )}

      {state.status === "error" && (
        <p className="mt-4 text-sm text-red-400">
          {state.error}
        </p>
      )}

      {state.status === "ready" && (
        <div className="mt-4 pt-4 border-t border-white/5">
          <p className="text-[11px] text-zinc-500 mb-2 italic">
            &ldquo;{state.query}&rdquo;
          </p>
          {state.data.answer ? (
            <>
              <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
                {state.data.answer}
              </p>
              {state.data.citations && state.data.citations.length > 0 && (
                <CitationChips citations={state.data.citations} />
              )}
            </>
          ) : (
            <p className="text-sm text-zinc-500">
              {state.data.message || `Nothing in the knowledge base matches that query for ${contactName}.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
