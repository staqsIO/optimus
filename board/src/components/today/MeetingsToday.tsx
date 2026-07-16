"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { inboxGet } from "@/components/inbox/shared";
import ProvenancePanel from "@/components/today/ProvenancePanel";

const SOURCE_LABEL: Record<string, string> = {
  tldv: "TL;DV",
  gemini: "Gemini",
  drive: "Drive",
};

interface ActionItem {
  id: string;
  signal_type: "action_item" | "commitment";
  content: string;
  due_date: string | null;
  confidence: number;
  domain: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface Participant {
  name?: string;
  email?: string;
  role?: string;
}

interface MeetingRow {
  document_id: string;
  source: string;
  source_id: string;
  title: string;
  happened_at: string;
  metadata: Record<string, unknown>;
  message_id: string | null;
  participants: Participant[] | null;
  action_items: ActionItem[];
  // OPT-2: the canonical key GET /api/provenance/:source_meeting_id matches on
  // (resolved server-side from the meeting.received signal). null = no meeting
  // signal yet → nothing to trace, so the trace icon is hidden.
  source_meeting_id: string | null;
}

interface AttendeeRow {
  email: string;
  name: string | null;
  meeting_count: string | number;
}

type Mode = "personal" | "as" | "all";

interface MeetingsTodayProps {
  /** Email the page is currently viewing as. Empty = no session email. */
  viewerEmail: string;
  /** Identity mode: personal (session), as (override), all (no filter). */
  mode: Mode;
  /** Optional: when set, banner shows "viewing as X" with a switch-back link. */
  sessionEmail: string;
  /** Optional YYYY-MM-DD override for the "today" window — eval/testing only. */
  day?: string;
}

function dayBoundsLocal(day?: string): { startIso: string; endIso: string } {
  let start: Date;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const [y, m, d] = day.split("-").map(Number);
    start = new Date(y, m - 1, d);
  } else {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Due dates are conceptually date-only values, not moments. The LLM extracts
// a calendar date (e.g. "2026-05-05") which Postgres stores as UTC midnight;
// rendering with the viewer's local TZ flips the displayed day backward by
// one near day boundaries. Display in UTC and compare on the UTC calendar
// day so "due May 5" actually renders as May 5 regardless of timezone.
function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDue(iso: string | null): string | null {
  if (!iso) return null;
  const due = new Date(iso);
  const today = new Date();
  if (utcDateKey(due) === utcDateKey(today)) return `due today ${formatTime(iso)}`;
  const days = Math.round((due.getTime() - today.getTime()) / (24 * 3600 * 1000));
  if (days > 0 && days < 7) {
    return `due ${due.toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" })}`;
  }
  return `due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

export default function MeetingsToday({ viewerEmail, mode, sessionEmail, day }: MeetingsTodayProps) {
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [attendees, setAttendees] = useState<AttendeeRow[] | null>(null);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [provenanceMeeting, setProvenanceMeeting] = useState<{ id: string; title: string } | null>(null);

  const bounds = useMemo(() => dayBoundsLocal(day), [day]);

  const fetchMeetings = useCallback(async () => {
    setError(null);
    setMeetings(null);
    const params = new URLSearchParams({ start_iso: bounds.startIso, end_iso: bounds.endIso });
    if (mode === "all") {
      params.set("all", "1");
    } else if (viewerEmail) {
      params.set("email", viewerEmail);
    } else {
      // No identity to filter on and not in "all" mode — surface as a soft empty.
      setMeetings([]);
      return;
    }
    try {
      const res = await inboxGet(`/api/today/meetings?${params}`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError({
          message: friendlyErrorMessage(data?.error || `HTTP ${res.status}`),
          details: data?.error || `HTTP ${res.status}`,
        });
        return;
      }
      setMeetings(data?.meetings || []);
    } catch (err) {
      const e = err as Error;
      setError({ message: "Couldn’t reach the meetings API.", details: e.message });
    }
  }, [bounds.endIso, bounds.startIso, mode, viewerEmail]);

  const fetchAttendees = useCallback(async () => {
    const params = new URLSearchParams({ start_iso: bounds.startIso, end_iso: bounds.endIso });
    try {
      const res = await inboxGet(`/api/today/meeting-attendees?${params}`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (res.ok && Array.isArray(data?.attendees)) setAttendees(data.attendees);
      else setAttendees([]);
    } catch {
      setAttendees([]);
    }
  }, [bounds.endIso, bounds.startIso]);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings, reloadKey]);
  useEffect(() => { fetchAttendees(); }, [fetchAttendees]);

  // ---------- mode banner ----------
  const banner = mode === "as" ? (
    <ModeBanner
      tone="info"
      text={<>Viewing as <span className="font-mono text-accent-bright">{viewerEmail}</span> · session is <span className="font-mono text-zinc-400">{sessionEmail}</span></>}
      action={<Link href="/today" className="text-accent-bright hover:underline text-xs">switch back</Link>}
    />
  ) : mode === "all" ? (
    <ModeBanner
      tone="warn"
      text={<>Viewing <strong>all meetings today</strong>, ignoring attendee filter</>}
      action={<Link href="/today" className="text-accent-bright hover:underline text-xs">filter to me</Link>}
    />
  ) : null;

  // ---------- error ----------
  if (error) {
    return (
      <div className="space-y-3">
        {banner}
        <ErrorState
          message={error.message}
          details={error.details}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      </div>
    );
  }

  // ---------- loading ----------
  if (meetings === null) {
    return (
      <div className="space-y-3">
        {banner}
        {[0, 1].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-surface-raised animate-pulse" />
        ))}
      </div>
    );
  }

  // ---------- empty ----------
  if (meetings.length === 0) {
    return (
      <div className="space-y-3">
        {banner}
        <EmptyState
          mode={mode}
          viewerEmail={viewerEmail}
          attendees={attendees}
        />
      </div>
    );
  }

  // ---------- list ----------
  return (
    <>
      <div className="space-y-3">
        {banner}
        <ul className="space-y-3">
          {meetings.map((m) => (
            <MeetingCard
              key={m.document_id}
              meeting={m}
              viewerEmail={viewerEmail}
              onTraceClick={(id, title) => setProvenanceMeeting({ id, title })}
            />
          ))}
        </ul>
      </div>

      {provenanceMeeting && (
        <ProvenancePanel
          meetingId={provenanceMeeting.id}
          meetingTitle={provenanceMeeting.title}
          onClose={() => setProvenanceMeeting(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MeetingCard({
  meeting: m,
  viewerEmail,
  onTraceClick,
}: {
  meeting: MeetingRow;
  viewerEmail: string;
  onTraceClick: (meetingId: string, title: string) => void;
}) {
  const otherAttendees = (m.participants || [])
    .filter((p) => p.email && p.email.toLowerCase() !== viewerEmail.toLowerCase())
    .map((p) => p.name || p.email)
    .filter(Boolean) as string[];

  const noActionsLabel = "no action items extracted";
  // Capture as a const so TS narrows it to `string` inside the trace-button
  // closure below (the OPT-2 provenance key; null when there's nothing to trace).
  const traceId = m.source_meeting_id;

  return (
    <li className="rounded-lg border border-white/5 bg-surface-raised/40 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <Link
          href={m.message_id ? `/meetings/${encodeURIComponent(m.message_id)}` : "#"}
          className="text-sm font-medium text-zinc-100 hover:text-accent-bright truncate"
        >
          {m.title || "(untitled meeting)"}
        </Link>
        <div className="flex items-center gap-2 shrink-0">
          {/* Chain / provenance trace button — shown only when the meeting has a
              source_meeting_id (the key GET /api/provenance/:id matches on).
              Hidden when null: nothing has been traced to/from this meeting yet. */}
          {traceId && (
            <button
              onClick={() => onTraceClick(traceId, m.title || "(untitled meeting)")}
              title="View provenance chain"
              aria-label="View provenance chain for this meeting"
              className="text-zinc-700 hover:text-zinc-300 transition-colors"
            >
              <svg
                aria-hidden="true"
                className="w-3.5 h-3.5"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M6.5 9.5a2.828 2.828 0 0 0 4 0l2-2a2.828 2.828 0 0 0-4-4l-1 1" />
                <path d="M9.5 6.5a2.828 2.828 0 0 0-4 0l-2 2a2.828 2.828 0 0 0 4 4l1-1" />
              </svg>
            </button>
          )}
          <span className="text-[11px] tabular-nums text-zinc-500">
            {formatTime(m.happened_at)} · {SOURCE_LABEL[m.source] || m.source}
          </span>
        </div>
      </div>

      {otherAttendees.length > 0 && (
        <p className="text-[11px] text-zinc-500 mb-2 truncate">
          with {otherAttendees.slice(0, 5).join(", ")}
          {otherAttendees.length > 5 && ` +${otherAttendees.length - 5}`}
        </p>
      )}

      {m.action_items.length === 0 ? (
        <p className="text-xs text-zinc-600 italic">— {noActionsLabel} —</p>
      ) : (
        <ul className="space-y-1.5">
          {m.action_items.map((a) => {
            const due = formatDue(a.due_date);
            return (
              <li key={a.id} className="flex items-start gap-2 text-sm text-zinc-200">
                <svg
                  aria-hidden="true"
                  className="shrink-0 mt-[5px] w-3 h-3 text-zinc-600"
                  viewBox="0 0 12 12"
                  fill="none"
                >
                  <rect
                    x="0.5"
                    y="0.5"
                    width="11"
                    height="11"
                    rx="2"
                    stroke="currentColor"
                  />
                </svg>
                <span className="flex-1 min-w-0">
                  <span>{a.content}</span>
                  {due && (
                    <span className="ml-2 text-[11px] text-amber-300/80">{due}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function EmptyState({
  mode,
  viewerEmail,
  attendees,
}: {
  mode: Mode;
  viewerEmail: string;
  attendees: AttendeeRow[] | null;
}) {
  const hasAttendees = (attendees?.length || 0) > 0;
  const otherAttendees = (attendees || []).filter(
    (a) => a.email && a.email.toLowerCase() !== viewerEmail.toLowerCase()
  );

  return (
    <div className="rounded-lg border border-white/5 bg-surface-raised/40 px-5 py-5 space-y-3">
      <div>
        <p className="text-sm text-zinc-300">
          {mode === "all"
            ? "No meetings have been ingested for today yet."
            : viewerEmail
              ? <>No meetings today have <span className="font-mono text-zinc-400">{viewerEmail}</span> in the attendee list.</>
              : "Sign in to see your meetings, or use the “Show all meetings” link below."}
        </p>
        <p className="text-xs text-zinc-500 mt-1">
          {mode === "all"
            ? "Once a tl;dv, Gemini, or voice-memo meeting from today lands in RAG, it shows up here."
            : "Either no meeting today included you, or the meeting’s attendee roster doesn’t carry your email."}
        </p>
      </div>

      {/* Suggest other emails to view as — useful when GitHub login email
          differs from the email on the meeting roster. */}
      {hasAttendees && otherAttendees.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
            Today’s meetings include these attendees
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {otherAttendees.slice(0, 12).map((a) => (
              <li key={a.email}>
                <Link
                  href={`/today?as=${encodeURIComponent(a.email)}`}
                  className="text-[11px] px-2 py-1 rounded bg-surface-overlay border border-white/5 text-zinc-300 hover:border-accent-bright/40 hover:text-accent-bright"
                  title={`View as ${a.name || a.email}`}
                >
                  {a.name || a.email}
                  <span className="ml-1.5 text-zinc-500">×{a.meeting_count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Show-all toggle. Cheaper to surface here than to require the operator
          to know the URL flag. */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {mode !== "all" && (
          <Link
            href="/today?all=1"
            className="text-xs text-accent-bright hover:underline"
          >
            Show all meetings today →
          </Link>
        )}
        {!hasAttendees && (
          <span className="text-[11px] text-zinc-600">
            Tip: ingest a meeting via the Knowledge Base to see this surface come alive.
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorState({
  message,
  details,
  onRetry,
}: {
  message: string;
  details?: string;
  onRetry: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-5 py-4">
      <p className="text-sm text-zinc-200">{message}</p>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          onClick={onRetry}
          className="px-2.5 py-1 rounded bg-surface-overlay border border-white/10 text-zinc-300 hover:border-accent-bright/40 hover:text-accent-bright"
        >
          Retry
        </button>
        {details && (
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="text-zinc-500 hover:text-zinc-300"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        )}
      </div>
      {showDetails && details && (
        <pre className="mt-3 text-[11px] text-red-300 whitespace-pre-wrap break-words font-mono bg-black/30 rounded p-2 max-h-40 overflow-auto">
          {details}
        </pre>
      )}
    </div>
  );
}

function ModeBanner({
  tone,
  text,
  action,
}: {
  tone: "info" | "warn";
  text: React.ReactNode;
  action?: React.ReactNode;
}) {
  const cls = tone === "warn"
    ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
    : "border-accent-bright/20 bg-accent-bright/5 text-zinc-200";
  return (
    <div className={`text-xs flex items-center justify-between gap-3 rounded-md border ${cls} px-3 py-2`}>
      <span>{text}</span>
      {action}
    </div>
  );
}

function friendlyErrorMessage(raw: string): string {
  const s = String(raw || "").toLowerCase();
  if (s === "not found") return "The meetings endpoint isn’t available on the deployed API yet (deploy still rolling out).";
  if (s.includes("invalid input syntax for type timestamp")) return "Some legacy meetings have a non-ISO timestamp and tripped the query. This usually means a fix is needed in ingestion.";
  if (s.includes("email param required")) return "We need an email to filter on, or pass all=1 to skip filtering.";
  if (s.includes("backend unreachable")) return "Couldn’t reach the meetings API.";
  return "Couldn’t load today’s meetings.";
}
