"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { inboxGet } from "@/components/inbox/shared";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePreferences } from "@/hooks/usePreferences";
import {
  assessSyncHealth,
  type CalendarWatch,
  type SyncHealth,
} from "@/lib/calendar-sync-health";

// /calendar — month grid + clickable cells (past, today, and future). The
// right rail loads an unioned event list for the selected day: scheduled
// Google Calendar events (gcal_event, STAQPRO-327), recorded meetings,
// signals (due / fired), and significant emails. Past and future days
// both render — past shows what happened, future shows what's scheduled.

/* ───────── Types ───────── */

interface DayCount {
  date: string; // YYYY-MM-DD
  meetings: number;
  signals_due: number;
  signals_fired: number;
  emails: number;
  gcal_events: number;
  total: number;
}

type EventKind = "meeting" | "signal_due" | "signal_fired" | "email" | "gcal_event";

interface CalendarEvent {
  kind: EventKind;
  id: string;
  time: string | null;
  title: string;
  subtitle: string;
  link_to: string | null;
  meta: Record<string, unknown>;
}

// STAQPRO-536: sync-health surfacing. The calendar poller writes last_poll_at
// / last_error per watch (cols added in mig 114). The board had no signal when
// the service-account poll stalled or errored — this banner makes that visible.
// The CalendarWatch type and assessSyncHealth() classifier live in
// @/lib/calendar-sync-health so the pure logic is unit-testable in the node
// vitest environment without rendering React.
interface WatchesResponse {
  watches?: CalendarWatch[];
  error?: string;
}

interface MonthsResponse {
  days?: DayCount[];
  error?: string;
}
interface DayResponse {
  date?: string;
  events?: CalendarEvent[];
  error?: string;
}

/* ───────── Date helpers ───────── */

function toIsoDate(d: Date): string {
  // Local-tz YYYY-MM-DD — matches the day the user sees on their wall clock.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/**
 * Returns the 6×7 = 42 cell grid that covers the visible month, padded with
 * trailing days from the previous month and leading days of the next so each
 * row is a full week. The grid always shows 6 weeks for layout stability.
 */
function monthGridCells(viewMonth: Date): Date[] {
  const first = startOfMonth(viewMonth);
  const startWeekday = first.getDay(); // 0=Sun
  const cells: Date[] = [];
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startWeekday);
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  return cells;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ───────── Page ───────── */

export default function CalendarPage() {
  const { isAuthenticated, isLoading: authLoading } = useCurrentUser();
  const today = useMemo(() => new Date(), []);
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState<string>(toIsoDate(today));

  const cells = useMemo(() => monthGridCells(viewMonth), [viewMonth]);

  // The grid's actual range (may include trailing/leading days from
  // adjacent months); we want counts for the entire visible window.
  const rangeStart = cells[0];
  const rangeEndExclusive = new Date(cells[cells.length - 1]);
  rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1);

  const [counts, setCounts] = useState<Record<string, DayCount>>({});
  const [countsError, setCountsError] = useState<string | null>(null);

  // OPT-126: shared-calendar legend. `scope=org` returns every watch with a
  // `mine` flag — the backend serves OWN calendars by default and only adds
  // teammates' events when explicitly ?include='d. The opt-in list persists
  // per user in server-backed preferences.
  const [watches, setWatches] = useState<CalendarWatch[]>([]);
  const { preferences, updatePreference } = usePreferences();
  const includedCalendars = useMemo(
    () => (preferences.calendar_included_calendars || []).map((e) => e.toLowerCase()),
    [preferences.calendar_included_calendars],
  );
  const includeParam = includedCalendars.length > 0
    ? `&include=${encodeURIComponent(includedCalendars.join(","))}`
    : "";

  const startIso = toIsoDate(rangeStart);
  const endIso = toIsoDate(rangeEndExclusive);
  const loadCounts = useCallback(() => {
    if (!isAuthenticated) return;
    const path = `/api/calendar/months?start=${startIso}&end=${endIso}${includeParam}`;
    inboxGet(path, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((d: MonthsResponse) => {
        if (d.error) { setCountsError(d.error); return; }
        const map: Record<string, DayCount> = {};
        for (const day of d.days || []) map[day.date] = day;
        setCounts(map);
        setCountsError(null);
      })
      .catch((e) => setCountsError(e?.message || "failed to load"));
  }, [startIso, endIso, includeParam, isAuthenticated]);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  // STAQPRO-536: poll watch health alongside counts so the banner reflects
  // the same data window the user is looking at.
  const loadWatches = useCallback(() => {
    if (!isAuthenticated) return;
    inboxGet("/api/calendar/watches?scope=org", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((d: WatchesResponse) => {
        if (d.error) return;
        setWatches(d.watches || []);
      })
      .catch(() => {});
  }, [isAuthenticated]);
  useEffect(() => { loadWatches(); }, [loadWatches]);

  const syncHealth = useMemo(() => assessSyncHealth(watches), [watches]);

  // One chip per distinct calendar email; mine always-on first, teammates
  // toggleable. A member with several watches (primary + secondary calendar)
  // collapses to one chip — events are keyed by account_email, not watch.
  const calendarChips = useMemo(() => {
    const byEmail = new Map<string, { email: string; label: string; mine: boolean }>();
    for (const w of watches) {
      const email = (w.account_email || "").toLowerCase();
      if (!email || byEmail.has(email)) continue;
      byEmail.set(email, {
        email,
        label: w.label || w.account_email,
        mine: w.mine === true,
      });
    }
    const all = [...byEmail.values()];
    return [...all.filter((c) => c.mine), ...all.filter((c) => !c.mine)];
  }, [watches]);

  const toggleCalendar = (email: string) => {
    const next = includedCalendars.includes(email)
      ? includedCalendars.filter((e) => e !== email)
      : [...includedCalendars, email];
    updatePreference("calendar_included_calendars", next);
  };

  const goPrev = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  const goNext = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));
  const goToday = () => {
    const t = new Date();
    setViewMonth(startOfMonth(t));
    setSelectedDate(toIsoDate(t));
  };

  if (authLoading) {
    return <div className="p-4 text-sm text-zinc-500">Loading…</div>;
  }
  if (!isAuthenticated) {
    return <p className="p-4 text-sm text-zinc-500">Sign in to view the calendar.</p>;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-49px)] bg-zinc-950 text-zinc-100">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Calendar</span>
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={goPrev}
            className="text-xs px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="text-sm text-zinc-200 font-medium tabular-nums px-2">
            {MONTH_LABELS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
          </span>
          <button
            onClick={goNext}
            className="text-xs px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            aria-label="Next month"
          >
            ›
          </button>
          <button
            onClick={goToday}
            className="text-xs px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors ml-1"
          >
            today
          </button>
        </div>
        {/* OPT-126: per-member calendar toggles. Own calendars are always on
            (the backend serves them unconditionally); teammates are opt-in. */}
        {calendarChips.length > 0 && (
          <div className="flex items-center gap-1.5 ml-4 min-w-0 overflow-x-auto">
            {calendarChips.map((c) => {
              const active = c.mine || includedCalendars.includes(c.email);
              return (
                <button
                  key={c.email}
                  onClick={c.mine ? undefined : () => toggleCalendar(c.email)}
                  disabled={c.mine}
                  title={c.mine ? `${c.email} (your calendar — always shown)` : `${c.email} — click to ${active ? "hide" : "show"}`}
                  className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap transition-colors ${
                    active
                      ? c.mine
                        ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30 cursor-default"
                        : "bg-white/10 text-zinc-200 border-white/20"
                      : "text-zinc-500 border-white/10 hover:text-zinc-300 hover:border-white/20"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          {countsError && (
            <span className="text-[11px] text-red-400">load error: {countsError}</span>
          )}
          <button
            onClick={() => { loadCounts(); loadWatches(); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            refresh
          </button>
        </div>
      </div>

      {/* STAQPRO-536: sync-health banner — surface stalled / errored calendar
          polls instead of failing silently. */}
      <SyncHealthBanner health={syncHealth} />

      {/* Body: grid (left) + day panel (right) */}
      <div className="flex flex-1 min-h-0">
        <MonthGrid
          cells={cells}
          viewMonth={viewMonth}
          today={today}
          selectedDate={selectedDate}
          onSelect={setSelectedDate}
          counts={counts}
        />
        <DayPanel date={selectedDate} today={today} includeParam={includeParam} />
      </div>
    </div>
  );
}

/* ───────── Sync-health banner (STAQPRO-536) ───────── */

function SyncHealthBanner({ health }: { health: SyncHealth }) {
  const { errored, stale } = health;
  if (errored.length === 0 && stale.length === 0) return null;

  // Errors are the louder signal (red); stale-but-no-error is a warning (amber).
  const tone = errored.length > 0
    ? "border-red-500/30 bg-red-500/10 text-red-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";

  const labelFor = (w: CalendarWatch) =>
    w.label || w.account_email || w.calendar_id || w.id;

  return (
    <div className={`shrink-0 border-b px-4 py-2 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5">⚠</span>
        <div className="space-y-1 min-w-0">
          {errored.length > 0 && (
            <div>
              <span className="font-semibold">
                {errored.length} calendar watch{errored.length === 1 ? "" : "es"} erroring.
              </span>{" "}
              <span className="text-red-200/80">
                Calendar sync uses a domain-wide-delegated service account — fixes are an admin
                action (see Settings → Calendar Watches). Affected:{" "}
                {errored.map(labelFor).join(", ")}.
              </span>
            </div>
          )}
          {stale.length > 0 && (
            <div>
              <span className="font-semibold">
                {stale.length} calendar watch{stale.length === 1 ? "" : "es"} stale
              </span>{" "}
              <span className="text-amber-200/80">
                (no successful poll in over 30 min). Affected: {stale.map(labelFor).join(", ")}.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────── Month grid ───────── */

function MonthGrid({
  cells,
  viewMonth,
  today,
  selectedDate,
  onSelect,
  counts,
}: {
  cells: Date[];
  viewMonth: Date;
  today: Date;
  selectedDate: string;
  onSelect: (iso: string) => void;
  counts: Record<string, DayCount>;
}) {
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-white/5 shrink-0">
        {WEEKDAY_LABELS.map((w) => (
          <div
            key={w}
            className="px-2 py-1.5 text-[10px] uppercase tracking-widest text-zinc-600 font-semibold"
          >
            {w}
          </div>
        ))}
      </div>

      {/* 6×7 grid */}
      <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0">
        {cells.map((cell, i) => {
          const iso = toIsoDate(cell);
          const inMonth = cell.getMonth() === viewMonth.getMonth();
          const isToday = isSameDay(cell, today);
          const isSelected = selectedDate === iso;
          const count = counts[iso];

          return (
            <DayCell
              key={i}
              date={cell}
              iso={iso}
              inMonth={inMonth}
              isToday={isToday}
              isSelected={isSelected}
              count={count}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}

function DayCell({
  date,
  iso,
  inMonth,
  isToday,
  isSelected,
  count,
  onSelect,
}: {
  date: Date;
  iso: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  count: DayCount | undefined;
  onSelect: (iso: string) => void;
}) {
  const baseColor = inMonth ? "text-zinc-300" : "text-zinc-700";

  const bg = isSelected
    ? "bg-violet-500/15 border-violet-400/40"
    : isToday
      ? "bg-cyan-500/5 border-cyan-400/30"
      : "border-white/5 hover:bg-white/[0.03]";

  return (
    <button onClick={() => onSelect(iso)} className="text-left h-full block">
      <div className={`h-full p-2 border-r border-b ${bg} flex flex-col gap-1 transition-colors cursor-pointer`}>
        <div className="flex items-center justify-between">
          <span className={`text-xs tabular-nums ${baseColor} ${isToday ? "font-bold text-cyan-300" : ""}`}>
            {date.getDate()}
          </span>
          {count && count.total > 0 && (
            <span className="text-[10px] tabular-nums text-zinc-500">{count.total}</span>
          )}
        </div>
        {count && inMonth && count.total > 0 && (
          <div className="flex flex-wrap gap-1">
            {count.gcal_events > 0 && (
              <CountChip label={count.gcal_events} tone="emerald" />
            )}
            {count.meetings > 0 && (
              <CountChip label={count.meetings} tone="violet" />
            )}
            {count.signals_due > 0 && (
              <CountChip label={count.signals_due} tone="amber" />
            )}
            {count.signals_fired > 0 && (
              <CountChip label={count.signals_fired} tone="zinc" />
            )}
            {count.emails > 0 && (
              <CountChip label={count.emails} tone="cyan" />
            )}
          </div>
        )}
      </div>
    </button>
  );
}

function CountChip({ label, tone }: { label: number; tone: "violet" | "cyan" | "amber" | "zinc" | "emerald" }) {
  const cls = tone === "violet"
    ? "bg-violet-500/15 text-violet-300 border-violet-500/30"
    : tone === "cyan"
      ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30"
      : tone === "amber"
        ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
        : tone === "emerald"
          ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
          : "bg-white/5 text-zinc-400 border-white/10";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border tabular-nums ${cls}`}>
      {label}
    </span>
  );
}

/* ───────── Day events panel ───────── */

const KIND_META: Record<EventKind, { label: string; tint: string }> = {
  gcal_event: { label: "Calendar", tint: "text-emerald-300 border-emerald-400/30 bg-emerald-500/10" },
  meeting: { label: "Meeting", tint: "text-violet-300 border-violet-400/30 bg-violet-500/10" },
  signal_due: { label: "Due", tint: "text-amber-300 border-amber-400/30 bg-amber-500/10" },
  signal_fired: { label: "Signal", tint: "text-zinc-400 border-white/10 bg-white/5" },
  email: { label: "Email", tint: "text-cyan-300 border-cyan-400/30 bg-cyan-500/10" },
};

function DayPanel({ date, today, includeParam }: { date: string; today: Date; includeParam: string }) {
  const { isAuthenticated } = useCurrentUser();
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isToday = date === toIsoDate(today);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    inboxGet(`/api/calendar/day?date=${encodeURIComponent(date)}${includeParam}`, {
      signal: AbortSignal.timeout(10000),
    })
      .then((r) => r.json())
      .then((d: DayResponse) => {
        if (cancelled) return;
        if (d.error) { setError(d.error); return; }
        setEvents(d.events || []);
      })
      .catch((e) => { if (!cancelled) setError(e?.message || "failed to load"); });
    return () => { cancelled = true; };
  }, [date, includeParam]);

  const labelDate = useMemo(() => {
    const [y, m, day] = date.split("-").map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }, [date]);

  const groups = useMemo(() => {
    if (!events) return null;
    const g: Record<EventKind, CalendarEvent[]> = {
      gcal_event: [], meeting: [], signal_due: [], signal_fired: [], email: [],
    };
    for (const ev of events) g[ev.kind].push(ev);
    return g;
  }, [events]);

  return (
    <aside className="w-full max-w-md shrink-0 border-l border-white/10 flex flex-col min-h-0">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">{labelDate}</h2>
          {isToday && (
            <span className="text-[10px] uppercase tracking-widest text-cyan-300">today</span>
          )}
        </div>
        {events && (
          <span className="text-xs text-zinc-500 tabular-nums">
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {!isAuthenticated && (
          <p className="text-sm text-zinc-500">Sign in to view day events.</p>
        )}

        {error && (
          <p className="text-xs text-red-400">Couldn&rsquo;t load: {error}</p>
        )}

        {!error && events === null && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 rounded bg-surface-raised animate-pulse" />
            ))}
          </div>
        )}

        {!error && events?.length === 0 && (
          <p className="text-sm text-zinc-500">Nothing on this day.</p>
        )}

        {groups && events && events.length > 0 && (
          <>
            <EventGroup title="Calendar" events={groups.gcal_event} />
            <EventGroup title="Meetings" events={groups.meeting} />
            <EventGroup title="Due" events={groups.signal_due} />
            <EventGroup title="Emails" events={groups.email} />
            <EventGroup title="Signals extracted" events={groups.signal_fired} />
          </>
        )}
      </div>
    </aside>
  );
}

function EventGroup({ title, events }: { title: string; events: CalendarEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">
        {title} <span className="text-zinc-700 tabular-nums">({events.length})</span>
      </h3>
      <ul className="space-y-1.5">
        {events.map((ev) => <EventRow key={ev.kind + ":" + ev.id} ev={ev} />)}
      </ul>
    </section>
  );
}

function EventRow({ ev }: { ev: CalendarEvent }) {
  const meta = KIND_META[ev.kind];
  const time = ev.time
    ? new Date(ev.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "";

  const inner = (
    <div className="border border-white/5 hover:border-white/15 hover:bg-white/[0.03] rounded p-2.5 transition-colors">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono uppercase tracking-wider ${meta.tint}`}>
          {meta.label}
        </span>
        {time && <span className="text-[11px] text-zinc-600 tabular-nums">{time}</span>}
      </div>
      <div className="text-sm text-zinc-200 line-clamp-2">{ev.title}</div>
      {ev.subtitle && (
        <div className="text-[11px] text-zinc-500 mt-0.5 line-clamp-1">{ev.subtitle}</div>
      )}
    </div>
  );

  if (ev.link_to) {
    return (
      <li>
        {/^https?:\/\//i.test(ev.link_to) ? (
          <a href={ev.link_to} target="_blank" rel="noopener noreferrer" className="block">
            {inner}
          </a>
        ) : (
          <Link href={ev.link_to} className="block">
            {inner}
          </Link>
        )}
      </li>
    );
  }
  return <li>{inner}</li>;
}
