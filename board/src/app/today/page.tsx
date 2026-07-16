"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { inboxGet } from "@/components/inbox/shared";
import MeetingsToday from "@/components/today/MeetingsToday";
import MorningBrief from "@/components/today/MorningBrief";
import MentionedToday from "@/components/today/MentionedToday";
import ObligationDrawer from "@/components/today/ObligationDrawer";
import type { Signal } from "./types";

// /today is intentionally narrow: the meetings the operator attended today
// and the action items they walked out with. Everything else lives elsewhere.
//
// URL params (all shareable):
//   default            → filter to the session email
//   ?as=<email>        → filter to a specific email (testing affordance)
//   ?all=1             → no attendee filter (admin sandbox use)
//   ?day=YYYY-MM-DD    → override the "today" window — eval/testing only

function todayLabel(dayOverride?: string): string {
  let d: Date;
  if (dayOverride && /^\d{4}-\d{2}-\d{2}$/.test(dayOverride)) {
    const [y, m, day] = dayOverride.split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date();
  }
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Local-tz day window as ISO strings. Server uses these so server-UTC
 * doesn't bleed into the next/previous day for west-coast callers. When
 * `dayOverride` is a YYYY-MM-DD string, that day is used instead of today —
 * eval/testing only.
 */
function todayWindow(dayOverride?: string): { startIso: string; endIso: string } {
  let start: Date;
  if (dayOverride && /^\d{4}-\d{2}-\d{2}$/.test(dayOverride)) {
    const [y, m, d] = dayOverride.split("-").map(Number);
    start = new Date(y, m - 1, d);
  } else {
    start = new Date();
    start.setHours(0, 0, 0, 0);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export default function TodayPage() {
  return (
    <Suspense fallback={
      <div className="space-y-6 max-w-3xl">
        <div className="h-8 w-40 rounded bg-surface-raised animate-pulse" />
        <div className="h-24 rounded-lg bg-surface-raised animate-pulse" />
      </div>
    }>
      <TodayPageContent />
    </Suspense>
  );
}

function TodayPageContent() {
  const { email: sessionEmail, displayName, isAuthenticated, isLoading } = useCurrentUser();
  const params = useSearchParams();
  const asEmail = params.get("as")?.trim() || "";
  const allFlag = params.get("all") === "1";
  const dayParam = params.get("day")?.trim() || "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : undefined;

  const mode: "personal" | "as" | "all" = allFlag ? "all" : asEmail ? "as" : "personal";
  const viewerEmail = mode === "as" ? asEmail : mode === "all" ? "" : sessionEmail;

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <div className="h-8 w-40 rounded bg-surface-raised animate-pulse" />
        <div className="h-24 rounded-lg bg-surface-raised animate-pulse" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <p className="text-sm text-zinc-500">Sign in to see your day.</p>;
  }

  const { startIso, endIso } = todayWindow(day);
  const briefScope: "personal" | "org" = mode === "all" ? "org" : "personal";

  return (
    <div className="space-y-6 max-w-3xl">
      <header className="flex items-start justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Today</h1>
        <div className="flex flex-col items-end gap-1 text-sm text-zinc-500">
          <div className="flex items-center gap-3">
            <ScopeToggle currentMode={mode} sessionEmail={sessionEmail} />
            <span>{todayLabel(day)}</span>
            {day && (
              <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                eval day
              </span>
            )}
          </div>
          {sessionEmail && (
            <span className="font-mono text-[11px] text-zinc-600">{sessionEmail}</span>
          )}
        </div>
      </header>

      {/* Phase 2 — Zone 1: prose Morning Brief from chief-of-staff perspective */}
      <MorningBrief
        scope={briefScope}
        email={sessionEmail}
        startIso={startIso}
        endIso={endIso}
        ownerHandle={displayName || undefined}
      />

      <section>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-3">
          {day
            ? mode === "all"
              ? `Meetings across the org on ${todayLabel(day)}`
              : `Meetings on ${todayLabel(day)}`
            : mode === "all"
              ? "Meetings across the org today"
              : "Meetings you had today"}
        </h2>
        <MeetingsToday
          viewerEmail={viewerEmail}
          mode={mode}
          sessionEmail={sessionEmail}
          day={day}
        />
        <p className="mt-2 text-[10px] text-zinc-700">
          Action items and commitments from each meeting&rsquo;s extracted
          signals — including ones any attendee committed to, not just the
          viewer. Resolved items are hidden.
        </p>
      </section>

      {/* New: meetings today where you were named but didn't attend */}
      {mode !== "all" && sessionEmail && (
        <MentionedToday email={sessionEmail} startIso={startIso} endIso={endIso} />
      )}

      {/* Phase 2 — Zone 3: open obligations always visible (no <details> gate) */}
      <OpenObligationsList userName={displayName || sessionEmail} />
    </div>
  );
}

/**
 * Personal | Org-wide toggle. Org-wide flips on `?all=1` URL param which
 * MeetingsToday already honors and which we propagate to the brief endpoint.
 */
function ScopeToggle({ currentMode, sessionEmail }: { currentMode: "personal" | "as" | "all"; sessionEmail: string }) {
  const isOrg = currentMode === "all";
  if (!sessionEmail && currentMode !== "all") return null;
  return (
    <div className="flex rounded-md border border-zinc-700/60 overflow-hidden text-[11px] font-medium">
      <a
        href="/today"
        className={`px-2.5 py-1 transition-colors ${
          !isOrg
            ? "bg-violet-500/15 text-violet-300"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Personal
      </a>
      <a
        href="/today?all=1"
        className={`px-2.5 py-1 transition-colors border-l border-zinc-700/60 ${
          isOrg
            ? "bg-cyan-500/15 text-cyan-300"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Org
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open obligations — Phase 2: always visible (no <details> gate), capped at
// 5 with a "View all" link to the Signals page when there's more.
// Urgency-density coloring: overdue = red border, due-this-week = amber.
// ---------------------------------------------------------------------------

function OpenObligationsList({ userName }: { userName: string }) {
  const [owe, setOwe] = useState<Signal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // OPT-159: the obligation whose detail drawer is open (null = closed).
  const [selected, setSelected] = useState<Signal | null>(null);

  const refetch = useCallback(() => {
    const ownerParam = userName ? `?owner=${encodeURIComponent(userName)}` : "";
    inboxGet(`/api/today${ownerParam}`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((d) => setOwe(d?.owe || []))
      .catch((e) => setError(e?.message || "failed to load"));
  }, [userName]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // OPT-159: after a verb fires, optimistically drop the row so Today reflects
  // the change instantly, then refetch to reconcile counts with the backend.
  const handleActioned = useCallback(
    (id: string) => {
      setOwe((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
      refetch();
    },
    [refetch],
  );

  const visible = owe?.slice(0, 5) ?? [];
  const overflow = owe && owe.length > 5 ? owe.length - 5 : 0;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          Open obligations
        </h2>
        {owe && owe.length > 0 && (
          <span className="text-[10px] text-zinc-600">
            {owe.length} total
          </span>
        )}
      </div>

      {error && <p className="text-xs text-red-400">Couldn&rsquo;t load: {error}</p>}

      {!error && owe === null && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded bg-surface-raised animate-pulse" />
          ))}
        </div>
      )}

      {!error && owe?.length === 0 && (
        <p className="text-xs text-zinc-500">Nothing open. You&rsquo;re clear.</p>
      )}

      {!error && visible.length > 0 && (
        <ul className="space-y-1.5">
          {visible.map((s) => {
            const overdue = s.due_date ? new Date(s.due_date).getTime() < Date.now() : false;
            const dueThisWeek = s.due_date
              ? !overdue && new Date(s.due_date).getTime() < Date.now() + 7 * 24 * 60 * 60 * 1000
              : false;
            // Use rounded-r so the stripe sits flush against a flat left edge —
            // Tailwind's rounded corner conflicted with the 2px border-l.
            const borderClass = overdue
              ? "border-l-2 border-l-red-500/70"
              : dueThisWeek
              ? "border-l-2 border-l-amber-500/70"
              : "border-l-2 border-l-transparent";
            return (
              <li key={s.id}>
                {/* OPT-159: each obligation is now a button that opens a detail
                    drawer with source, people, dates, and inline actions. */}
                <button
                  type="button"
                  onClick={() => setSelected(s)}
                  className={`w-full flex items-start gap-2 px-3 py-2 rounded-r bg-surface-raised/40 text-sm text-zinc-300 text-left hover:bg-surface-raised/70 transition-colors cursor-pointer ${borderClass}`}
                >
                  <span className="flex-1 min-w-0">
                    <span>{s.content}</span>
                    {s.due_date && (
                      <span
                        className={`ml-2 text-[11px] ${
                          overdue ? "text-red-300" : dueThisWeek ? "text-amber-300/80" : "text-zinc-500"
                        }`}
                      >
                        {overdue ? "overdue · " : "due "}
                        {new Date(s.due_date).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true" className="text-zinc-600">›</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {overflow > 0 && (
        <a
          href="/signals?direction=inbound&resolved=false"
          className="mt-2 inline-block text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          View all {owe!.length} obligations →
        </a>
      )}

      {/* OPT-159: detail drawer for the selected obligation. */}
      <ObligationDrawer
        obligation={selected}
        onClose={() => setSelected(null)}
        onActioned={handleActioned}
      />
    </section>
  );
}
