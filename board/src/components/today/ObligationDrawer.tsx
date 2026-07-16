"use client";

// OPT-159 — Close the obligation loop (feature spec 010, US-1).
//
// The /today "Open obligations" rows used to be flat, non-interactive text.
// This drawer makes each one actionable: it shows the obligation's source
// (originating email/meeting thread), the people involved, the dates, and
// inline verb buttons (done / later / not-for-me) wired to the SAME backend
// action API the /issues board already uses.
//
// Per-viewer scoping: every call goes through /api/inbox-proxy, which mints a
// verified board JWT (ADR-019) from the NextAuth session. The backend derives
// identity + tenancy from that JWT (STAQPRO-588 / OPT-115 / OPT-126). This
// component never sets identity headers itself, so viewer scoping is preserved.

import { useEffect, useState } from "react";
import Link from "next/link";
import { inboxGet, ChannelPill } from "@/components/inbox/shared";
import type { Signal } from "@/app/today/types";

type Verb = "done" | "later" | "not_for_me";

// Mirrors VERB_LABEL in board/src/app/issues/page.tsx. "skip" is intentionally
// omitted on /today — the obligation list surfaces things you still owe, so the
// meaningful exits are: did it (done), snooze it (later), or it isn't yours
// (not_for_me). "Skip" remains available on the full /issues board.
const VERB_LABEL: Record<Verb, string> = {
  done: "Done",
  later: "Snooze",
  not_for_me: "Not for me",
};

function fmtDate(s: string | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(
    undefined,
    opts || { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
  );
}

export default function ObligationDrawer({
  obligation,
  onClose,
  onActioned,
}: {
  obligation: Signal | null;
  onClose: () => void;
  // Fired after a successful verb so the parent can drop/refetch the row.
  onActioned: (id: string, verb: Verb) => void;
}) {
  const open = obligation !== null;

  const [submitting, setSubmitting] = useState<Verb | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy-loaded source email body (read-more / click-through without leaving).
  const [body, setBody] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<"idle" | "loading" | "error">("idle");

  // Reset transient state whenever the drawer target changes.
  useEffect(() => {
    setSubmitting(null);
    setError(null);
    setBody(null);
    setBodyState("idle");
  }, [obligation?.id]);

  // Body-scroll lock + Escape-to-close, matching AgendaSlideOver's idiom.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!obligation) return null;
  const o = obligation;

  const overdue = o.due_date ? new Date(o.due_date).getTime() < Date.now() : false;
  const person = o.from_name || o.from_address || null;
  // Same source-thread click-through the /issues board uses (issues/page.tsx).
  const sourceHref = o.message_id
    ? `/meetings?id=${encodeURIComponent(o.message_id)}`
    : null;

  async function fire(verb: Verb) {
    setSubmitting(verb);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/human-tasks/${encodeURIComponent(o.id)}/action`,
          body: { verb },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      onActioned(o.id, verb);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(null);
    }
  }

  function loadBody() {
    if (!o.message_id || bodyState === "loading") return;
    setBodyState("loading");
    inboxGet(`/api/emails/body?id=${encodeURIComponent(o.message_id)}`, {
      signal: AbortSignal.timeout(8000),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        setBody(d?.body || d?.text || d?.snippet || "");
        setBodyState("idle");
      })
      .catch(() => setBodyState("error"));
  }

  return (
    <>
      {/* Backdrop — click to close. */}
      <div
        className="fixed inset-0 z-40 bg-black/50 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Right-side slide-over panel. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Obligation detail"
        className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-zinc-900 border-l border-white/10 shadow-2xl overflow-y-auto"
      >
        <div className="px-5 py-4 space-y-5">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Obligation
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-200 transition-colors text-sm"
              aria-label="Close"
            >
              Close ✕
            </button>
          </div>

          {/* The obligation itself */}
          <div
            className={`rounded-r bg-surface-raised/50 px-3 py-3 text-sm text-zinc-200 border-l-2 ${
              overdue ? "border-l-red-500/70" : "border-l-transparent"
            }`}
          >
            {o.content}
          </div>

          {/* Dates */}
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-zinc-500 uppercase tracking-wider text-[10px] mb-0.5">
                Due
              </dt>
              <dd className={overdue ? "text-red-300" : "text-zinc-300"}>
                {o.due_date ? `${overdue ? "Overdue · " : ""}${fmtDate(o.due_date)}` : "No due date"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500 uppercase tracking-wider text-[10px] mb-0.5">
                Created
              </dt>
              <dd className="text-zinc-300">{fmtDate(o.created_at) || "—"}</dd>
            </div>
          </dl>

          {/* People involved */}
          {(person || o.from_address) && (
            <div className="text-xs">
              <p className="text-zinc-500 uppercase tracking-wider text-[10px] mb-1">
                From
              </p>
              <p className="text-zinc-300">
                {person}
                {o.from_name && o.from_address && (
                  <span className="text-zinc-500"> · {o.from_address}</span>
                )}
              </p>
              {o.is_vip && (
                <span className="mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300">
                  VIP
                </span>
              )}
            </div>
          )}

          {/* Source thread */}
          <div className="space-y-2">
            <p className="text-zinc-500 uppercase tracking-wider text-[10px]">Source</p>
            {o.subject ? (
              <div className="flex items-center gap-2 text-sm text-zinc-300">
                <ChannelPill channel={o.channel} webhookSource={o.webhook_source} />
                <span className="min-w-0 truncate">{o.subject}</span>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">Source message no longer available.</p>
            )}

            {o.message_id && (
              <div className="flex flex-wrap gap-3 text-[11px]">
                {bodyState !== "loading" && body === null && (
                  <button
                    type="button"
                    onClick={loadBody}
                    className="text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Read more
                  </button>
                )}
                {bodyState === "loading" && <span className="text-zinc-500">Loading…</span>}
                {bodyState === "error" && (
                  <span className="text-red-400">Couldn&rsquo;t load body</span>
                )}
                {sourceHref && (
                  <Link
                    href={sourceHref}
                    className="text-violet-300 hover:text-violet-200 transition-colors"
                  >
                    Open thread →
                  </Link>
                )}
              </div>
            )}

            {body !== null && (
              <div className="mt-1 max-h-64 overflow-y-auto rounded bg-surface-raised/40 px-3 py-2 text-xs text-zinc-400 whitespace-pre-wrap">
                {body || "(empty)"}
              </div>
            )}
          </div>

          {/* Inline action buttons */}
          <div className="pt-2 border-t border-white/5 space-y-2">
            {error && <p className="text-[11px] text-red-400">{error}</p>}
            <div className="flex gap-3 text-[11px] uppercase tracking-wider">
              {(["done", "later", "not_for_me"] as Verb[]).map((verb) => (
                <button
                  key={verb}
                  type="button"
                  onClick={() => fire(verb)}
                  disabled={submitting !== null}
                  className={`transition-colors disabled:opacity-50 ${
                    verb === "done"
                      ? "text-green-300 hover:text-green-200"
                      : verb === "not_for_me"
                        ? "text-zinc-500 hover:text-zinc-300"
                        : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {submitting === verb ? "…" : VERB_LABEL[verb]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
