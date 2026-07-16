"use client";

import { useState, useEffect } from "react";
import { inboxGet, timeAgo } from "@/components/inbox/shared";
import { type Draft } from "./QueueItem";

// ---------------------------------------------------------------------------
// ThreadView — Parent message + collapsible thread
// ---------------------------------------------------------------------------

export default function ThreadView({
  draft,
  /** When set, shows this body only — no email/thread API calls (stakeholder demo). */
  demoStaticBody,
}: {
  draft: Draft;
  demoStaticBody?: string;
}) {
  const email = draft.emails;
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [emailBodyLoading, setEmailBodyLoading] = useState(false);
  const [showFullEmail, setShowFullEmail] = useState(false);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadExpanded, setThreadExpanded] = useState(false);

  // Reset state when draft changes
  useEffect(() => {
    setEmailBody(null);
    setShowFullEmail(false);
    setThreadMessages([]);
    setThreadExpanded(false);
  }, [draft.id]);

  // Fetch full email body
  const fetchEmailBody = () => {
    if (emailBodyLoading || emailBody !== null) return;
    setEmailBodyLoading(true);
    setShowFullEmail(true);
    // Delay skeleton by 200ms
    const timer = setTimeout(() => {}, 200);
    inboxGet(`/api/emails/body?id=${encodeURIComponent(draft.message_id)}`)
      .then((r) => r.json())
      .then((data) => {
        setEmailBody(data.body || data.snippet || "(No body available)");
      })
      .catch(() => {
        setEmailBody(email.snippet || "(Failed to load email body)");
      })
      .finally(() => {
        clearTimeout(timer);
        setEmailBodyLoading(false);
      });
  };

  // Fetch thread messages
  const fetchThread = () => {
    if (threadLoading || !email.thread_id) return;
    setThreadLoading(true);
    setThreadExpanded(true);
    inboxGet(`/api/emails/thread/${encodeURIComponent(email.thread_id)}`)
      .then((r) => r.json())
      .then((data) => {
        setThreadMessages(data.messages || []);
      })
      .catch(() => {
        setThreadMessages([]);
      })
      .finally(() => setThreadLoading(false));
  };

  const isDemo = demoStaticBody != null;

  return (
    <div className="px-4 py-4 border-b border-white/5">
      {/* Thread expander */}
      {!isDemo && email.thread_id && !threadExpanded && (
        <button
          onClick={fetchThread}
          className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors mb-3 flex items-center gap-1"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 6h8M6 2v8" strokeLinecap="round" />
          </svg>
          Show earlier messages
        </button>
      )}

      {/* Thread messages (expanded) */}
      {!isDemo && threadExpanded && (
        <div className="space-y-3 mb-4">
          {threadLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-3 w-1/3 bg-zinc-800 rounded" />
              <div className="h-3 w-full bg-zinc-800 rounded" />
              <div className="h-3 w-2/3 bg-zinc-800 rounded" />
            </div>
          ) : threadMessages.length === 0 ? (
            <p className="text-xs text-zinc-600">No earlier messages in thread</p>
          ) : (
            threadMessages.map((msg, i) => (
              <div key={msg.id || i} className="bg-surface-overlay/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-zinc-300">{msg.from_name || msg.from_address}</span>
                  <span className="text-[10px] text-zinc-600">{msg.received_at ? timeAgo(msg.received_at) : ""}</span>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">{msg.snippet || msg.body || ""}</p>
              </div>
            ))
          )}
          {threadMessages.length > 0 && (
            <button
              onClick={() => setThreadExpanded(false)}
              className="text-[10px] text-zinc-600 hover:text-zinc-500 transition-colors"
            >
              Collapse thread
            </button>
          )}
        </div>
      )}

      {/* Parent message — always visible */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs uppercase tracking-wider text-zinc-500">
            Original {(email.channel || draft.channel || "email") === "slack" ? "message" : "email"}
          </span>
          <span className="text-xs text-zinc-400 font-medium">
            {email.from_name || email.from_address}
          </span>
          {email.received_at && (
            <span className="text-[10px] text-zinc-600">
              {new Date(email.received_at).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>

        {/* Subject line */}
        <div className="text-sm font-medium text-zinc-200 mb-2">
          {email.subject || "(no subject)"}
        </div>

        {/* Email snippet / body */}
        <div className="bg-surface-overlay/30 rounded-lg p-4 max-h-[300px] overflow-y-auto">
          {isDemo ? (
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
              {demoStaticBody}
            </pre>
          ) : showFullEmail && emailBodyLoading ? (
            <SkeletonLines />
          ) : showFullEmail && emailBody ? (
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
              {emailBody}
            </pre>
          ) : (
            <p className="text-sm text-zinc-300 leading-relaxed">
              {email.snippet || "(No preview available)"}
            </p>
          )}
        </div>

        {/* Show full email button */}
        {!isDemo && !showFullEmail && (
          <button
            onClick={fetchEmailBody}
            className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors mt-2"
          >
            Show full email
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThreadMessage {
  id?: string;
  from_name?: string;
  from_address?: string;
  snippet?: string;
  body?: string;
  received_at?: string;
}

// ---------------------------------------------------------------------------
// Skeleton Loading
// ---------------------------------------------------------------------------

function SkeletonLines() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 w-full bg-zinc-800 rounded" />
      <div className="h-3 w-4/5 bg-zinc-800 rounded" />
      <div className="h-3 w-3/5 bg-zinc-800 rounded" />
    </div>
  );
}
