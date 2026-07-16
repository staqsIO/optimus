"use client";

import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";
import { formatTime, formatDate } from "@/lib/format";

/* ───────── Types ───────── */

type MeetingSource = "voice_memo" | "tldv" | "gemini_meet";

interface ExtractedSignal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  resolved: boolean;
  direction: string | null;
  domain: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface Participant {
  email?: string;
  name?: string;
}

interface MeetingRow {
  message_id: string;
  received_at: string;
  primary_speaker: string | null;
  title: string | null;
  transcript_snippet: string | null;
  labels: string[];
  source: MeetingSource | null;
  work_item_id: string | null;
  work_item_status: string | null;
  work_item_title: string | null;
  tracking_id: string | null;
  transcript_id: string | null;
  audio_url: string | null;
  audio_bytes: string | null;
  recorded_at: string | null;
  recording_name: string | null;
  extracted_signals: ExtractedSignal[];
  participants?: Participant[] | null;
}

interface MeetingDetail extends MeetingRow {
  transcript: string | null;
  work_item_assigned_to: string | null;
  voice_memo_status: string | null;
}

interface MeetingsResponse {
  meetings: MeetingRow[];
  limit: number;
  offset: number;
}

interface MeetingDetailResponse {
  meeting?: MeetingDetail;
  error?: string;
}

const SOURCE_META: Record<MeetingSource, { label: string; chip: string; tint: string }> = {
  voice_memo: { label: "Voice Memo", chip: "VM", tint: "text-violet-300 border-violet-400/30 bg-violet-500/10" },
  tldv: { label: "TL;DV", chip: "TLDV", tint: "text-cyan-300 border-cyan-400/30 bg-cyan-500/10" },
  gemini_meet: { label: "Google Meet", chip: "MEET", tint: "text-emerald-300 border-emerald-400/30 bg-emerald-500/10" },
} as const;

const SOURCE_ORDER: ReadonlyArray<MeetingSource | "all"> = ["all", "voice_memo", "tldv", "gemini_meet"] as const;

/* ───────── Helpers ───────── */

function SourceBadge({ source }: { source: MeetingSource | null }) {
  if (!source) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-zinc-500 font-mono">
        ?
      </span>
    );
  }
  const meta = SOURCE_META[source];
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono uppercase tracking-wider ${meta.tint}`}>
      {meta.chip}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const tone =
    status === "completed"
      ? "text-emerald-300 border-emerald-400/30 bg-emerald-500/10"
      : status === "failed" || status === "blocked"
      ? "text-red-300 border-red-400/30 bg-red-500/10"
      : status === "in_progress" || status === "review"
      ? "text-amber-300 border-amber-400/30 bg-amber-500/10"
      : "text-zinc-400 border-white/10 bg-white/5";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${tone}`}>{status}</span>
  );
}

function formatDuration(audioBytes: string | null): string | null {
  if (!audioBytes) return null;
  const bytes = Number(audioBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const approxSec = Math.round(bytes / 16000);
  if (approxSec < 60) return `~${approxSec}s`;
  return `~${Math.floor(approxSec / 60)}m ${approxSec % 60}s`;
}

/** Highlight occurrences of `q` in `text` by wrapping them in a <mark>. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-amber-400/30 text-amber-200 rounded-[2px]">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

/* ───────── Cross-links panel section ───────── */

function CrossLinksSection({ detail }: { detail: MeetingDetail }) {
  const participants: Participant[] = Array.isArray(detail.participants)
    ? detail.participants
    : [];
  const signals = detail.extracted_signals ?? [];
  const hasLinks = participants.length > 0 || signals.length > 0;
  if (!hasLinks) return null;

  return (
    <section>
      <h4 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Cross-links</h4>
      <div className="space-y-3">
        {/* Participants → contacts */}
        {participants.length > 0 && (
          <div>
            <p className="text-[10px] text-zinc-600 mb-1.5">Participants</p>
            <ul className="space-y-1">
              {participants.map((p, i) => {
                const label = p.name || p.email || "(unknown)";
                return (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                    {p.email ? (
                      <Link
                        href={`/contacts?q=${encodeURIComponent(p.email)}`}
                        className="text-violet-300 hover:text-violet-200 underline underline-offset-2 transition-colors"
                      >
                        {label}
                      </Link>
                    ) : (
                      <span className="text-zinc-400">{label}</span>
                    )}
                    {p.name && p.email && (
                      <span className="text-zinc-600 text-[10px]">{p.email}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Signals → /signals */}
        {signals.length > 0 && (
          <div>
            <p className="text-[10px] text-zinc-600 mb-1.5">
              Signals ({signals.length}){" "}
              <Link
                href="/signals"
                className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
              >
                view all signals →
              </Link>
            </p>
            <ul className="space-y-1">
              {signals.slice(0, 5).map((sig) => (
                <li
                  key={sig.id}
                  className="flex items-start gap-2 text-xs border border-white/5 rounded p-2 bg-white/[0.02]"
                >
                  <span className="text-cyan-400 font-mono uppercase tracking-wider shrink-0 text-[10px] pt-0.5">
                    {sig.signal_type}
                  </span>
                  <span className="text-zinc-300 line-clamp-2">{sig.content}</span>
                </li>
              ))}
              {signals.length > 5 && (
                <li className="text-[10px] text-zinc-600 pl-2">
                  +{signals.length - 5} more signals
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/* ───────── Detail Panel ───────── */

type TranscriptView = "summary" | "full";

function MeetingDetailPanel({
  messageId,
  searchQuery,
  onClose,
}: {
  messageId: string;
  searchQuery: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcriptView, setTranscriptView] = useState<TranscriptView>("summary");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    opsFetch<MeetingDetailResponse>(`/api/meetings/${encodeURIComponent(messageId)}`).then((res) => {
      if (cancelled) return;
      if (!res || res.error) {
        setError(res?.error || "Failed to load meeting");
        setLoading(false);
        return;
      }
      setDetail(res.meeting || null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Decide which transcript text to display based on view mode
  const transcriptText = useMemo(() => {
    if (!detail) return null;
    if (transcriptView === "full") return detail.transcript;
    // summary = snippet (already in list data) or first 800 chars of transcript
    return (
      detail.transcript_snippet ||
      (detail.transcript ? detail.transcript.slice(0, 800) + (detail.transcript.length > 800 ? "…" : "") : null)
    );
  }, [detail, transcriptView]);

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-zinc-950 border-l border-white/10 shadow-2xl z-40 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {detail?.source && <SourceBadge source={detail.source} />}
          <h3 className="text-sm font-semibold text-zinc-200 truncate">
            {detail?.title || (loading ? "Loading…" : "Meeting")}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          close ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {loading && (
          <div className="text-sm text-zinc-500">Loading meeting…</div>
        )}
        {error && (
          <div className="text-sm text-red-400 border border-red-400/20 bg-red-500/5 rounded p-3">{error}</div>
        )}
        {detail && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              {detail.primary_speaker && <span>{detail.primary_speaker}</span>}
              <span>·</span>
              <span>{formatDate(detail.received_at)}</span>
              {detail.audio_bytes && (
                <>
                  <span>·</span>
                  <span>{formatDuration(detail.audio_bytes)}</span>
                </>
              )}
              {detail.work_item_status && (
                <>
                  <span>·</span>
                  <StatusBadge status={detail.work_item_status} />
                </>
              )}
            </div>

            {detail.audio_url && (
              <section>
                <h4 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Audio</h4>
                <audio controls preload="none" src={detail.audio_url} className="w-full" />
              </section>
            )}

            {/* Cross-links: participants → contacts, signals */}
            <CrossLinksSection detail={detail} />

            {/* Transcript with summary/full toggle */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[10px] uppercase tracking-widest text-zinc-500">Transcript</h4>
                {detail.transcript && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setTranscriptView("summary")}
                      className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                        transcriptView === "summary"
                          ? "bg-zinc-700 text-zinc-200"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      summary
                    </button>
                    <button
                      onClick={() => setTranscriptView("full")}
                      className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                        transcriptView === "full"
                          ? "bg-zinc-700 text-zinc-200"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      full
                    </button>
                  </div>
                )}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-300 leading-relaxed border border-white/5 rounded p-3 bg-white/[0.02]">
                {transcriptText ? (
                  <HighlightedText text={transcriptText} query={searchQuery} />
                ) : (
                  "(no transcript available)"
                )}
              </pre>
              {transcriptView === "summary" && detail.transcript && detail.transcript.length > 800 && (
                <button
                  onClick={() => setTranscriptView("full")}
                  className="mt-1 text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
                >
                  show full transcript ({detail.transcript.length.toLocaleString()} chars) →
                </button>
              )}
            </section>

            {/* Extracted Signals full list */}
            {detail.extracted_signals && detail.extracted_signals.length > 0 && (
              <section>
                <h4 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">
                  Extracted Signals ({detail.extracted_signals.length})
                </h4>
                <ul className="space-y-2">
                  {detail.extracted_signals.map((sig) => (
                    <li
                      key={sig.id}
                      className="border border-white/5 rounded p-3 text-xs space-y-1 bg-white/[0.02]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-cyan-400 font-mono uppercase tracking-wider">{sig.signal_type}</span>
                        {sig.confidence !== null && (
                          <span className="text-[10px] text-zinc-500">{Math.round(sig.confidence * 100)}%</span>
                        )}
                        {sig.resolved && (
                          <span className="text-[10px] text-emerald-400">resolved</span>
                        )}
                        {sig.due_date && (
                          <span className="text-[10px] text-amber-300">due {formatDate(sig.due_date)}</span>
                        )}
                      </div>
                      <p className="text-zinc-300">
                        <HighlightedText text={sig.content} query={searchQuery} />
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.work_item_id && (
              <section>
                <h4 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Work Item</h4>
                <div className="border border-white/5 rounded p-3 text-xs space-y-1 bg-white/[0.02]">
                  <div className="text-zinc-300">{detail.work_item_title || detail.work_item_id}</div>
                  <div className="flex items-center gap-2 text-zinc-500">
                    <StatusBadge status={detail.work_item_status} />
                    {detail.work_item_assigned_to && <span>→ {detail.work_item_assigned_to}</span>}
                  </div>
                </div>
              </section>
            )}

            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Raw metadata</summary>
              <pre className="mt-2 font-mono text-[10px] leading-relaxed text-zinc-600 overflow-x-auto">
                {JSON.stringify(detail, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

/* ───────── Search helpers ───────── */

function meetingMatchesQuery(m: MeetingRow, q: string): boolean {
  if (!q.trim()) return true;
  const lower = q.toLowerCase();
  if (m.title?.toLowerCase().includes(lower)) return true;
  if (m.transcript_snippet?.toLowerCase().includes(lower)) return true;
  if (m.primary_speaker?.toLowerCase().includes(lower)) return true;
  if (m.recording_name?.toLowerCase().includes(lower)) return true;
  if (
    Array.isArray(m.participants) &&
    m.participants.some(
      (p) =>
        p.email?.toLowerCase().includes(lower) ||
        p.name?.toLowerCase().includes(lower)
    )
  )
    return true;
  if (
    m.extracted_signals?.some((s) => s.content?.toLowerCase().includes(lower))
  )
    return true;
  return false;
}

/* ───────── Page ───────── */

export default function MeetingsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-zinc-500">Loading meetings…</div>}>
      <MeetingsPageContent />
    </Suspense>
  );
}

function MeetingsPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const idParam = searchParams.get("id");
  const qParam = searchParams.get("q") ?? "";

  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSource, setFilterSource] = useState<MeetingSource | "all">("all");
  const [liveMode, setLiveMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(idParam);
  const [searchQuery, setSearchQuery] = useState<string>(qParam);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep selectedId in sync with the URL so /meetings?id=X opens the right panel.
  useEffect(() => {
    setSelectedId(idParam);
  }, [idParam]);

  // Keep searchQuery in sync with the URL ?q= param.
  useEffect(() => {
    setSearchQuery(qParam);
  }, [qParam]);

  const openMeeting = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("id", id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const closeMeeting = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("id");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchQuery(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) {
        params.set("q", value);
      } else {
        params.delete("q");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (filterSource !== "all") params.set("source", filterSource);
    const res = await opsFetch<MeetingsResponse>(`/api/meetings?${params.toString()}`);
    if (res?.meetings) setMeetings(res.meetings);
    setLoading(false);
  }, [filterSource]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (liveMode) {
      intervalRef.current = setInterval(fetchData, 30000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [liveMode, fetchData]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: meetings.length, voice_memo: 0, tldv: 0, gemini_meet: 0 };
    for (const m of meetings) if (m.source) c[m.source]++;
    return c;
  }, [meetings]);

  // Client-side search + source filter combined
  const filteredMeetings = useMemo(() => {
    return meetings.filter((m) => meetingMatchesQuery(m, searchQuery));
  }, [meetings, searchQuery]);

  return (
    <div className="flex flex-col h-[calc(100vh-49px)] bg-zinc-950 text-zinc-100">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Meetings</span>
        <a
          href="/meetings/registry"
          className="text-[11px] text-zinc-500 hover:text-violet-300 transition-colors"
          title="Canonical meetings deduped across sources, with personal→org promotion"
        >
          registry →
        </a>
        <div className="flex items-center gap-1">
          {SOURCE_ORDER.map((src) => {
            const label = src === "all" ? "All" : SOURCE_META[src].label;
            const active = filterSource === src;
            return (
              <button
                key={src}
                onClick={() => setFilterSource(src)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  active
                    ? "bg-violet-600 text-white"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                }`}
              >
                {label} <span className="text-[10px] opacity-60">{counts[src] ?? 0}</span>
              </button>
            );
          })}
        </div>

        {/* Search box */}
        <div className="relative flex items-center ml-1">
          <span className="absolute left-2 text-zinc-600 text-[10px] pointer-events-none select-none">⌕</span>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search transcripts, titles, participants…"
            className="text-xs bg-white/5 border border-white/10 rounded pl-5 pr-2 py-0.5 w-56 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => handleSearch("")}
              className="absolute right-1.5 text-zinc-500 hover:text-zinc-300 text-[10px] transition-colors"
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            refresh
          </button>
          <button
            onClick={() => setLiveMode((v) => !v)}
            className={`text-xs transition-colors ${liveMode ? "text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
            title="Auto-refresh every 30s"
          >
            {liveMode ? "● live" : "○ live"}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">Loading meetings…</div>
        ) : filteredMeetings.length === 0 ? (
          <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
            {meetings.length === 0
              ? "No meetings yet. Voice memos, TL;DV recordings, and Google Meet transcripts will land here."
              : `No meetings match "${searchQuery}".`}
          </div>
        ) : (
          <ul className="space-y-2 max-w-4xl mx-auto">
            {filteredMeetings.map((m) => {
              const signalCount = m.extracted_signals?.length ?? 0;
              const duration = formatDuration(m.audio_bytes);
              const isSelected = selectedId === m.message_id;
              return (
                <li key={m.message_id}>
                  <button
                    onClick={() => openMeeting(m.message_id)}
                    className={`w-full text-left border rounded-lg p-3 transition-colors ${
                      isSelected
                        ? "border-violet-500/40 bg-violet-500/5"
                        : "border-white/5 hover:border-white/15 hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <SourceBadge source={m.source} />
                      <span className="text-sm text-zinc-200 font-medium truncate flex-1">
                        {searchQuery ? (
                          <HighlightedText
                            text={m.title || m.recording_name || "Untitled meeting"}
                            query={searchQuery}
                          />
                        ) : (
                          m.title || m.recording_name || "Untitled meeting"
                        )}
                      </span>
                      <StatusBadge status={m.work_item_status} />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">
                      {m.primary_speaker && <span>{m.primary_speaker}</span>}
                      {m.primary_speaker && <span>·</span>}
                      <span>{formatDate(m.received_at)}</span>
                      <span className="text-zinc-700">{formatTime(m.received_at)}</span>
                      {duration && (
                        <>
                          <span>·</span>
                          <span>{duration}</span>
                        </>
                      )}
                      {signalCount > 0 && (
                        <span className="ml-auto text-cyan-400">
                          {signalCount} signal{signalCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    {m.transcript_snippet && (
                      <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                        {searchQuery ? (
                          <HighlightedText text={m.transcript_snippet} query={searchQuery} />
                        ) : (
                          m.transcript_snippet
                        )}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-white/5 flex items-center gap-4 text-xs text-zinc-700 shrink-0">
        <span>
          {searchQuery
            ? `${filteredMeetings.length} / ${meetings.length} meetings`
            : `${meetings.length} meetings`}
        </span>
        {filterSource !== "all" && <span className="text-violet-400">filtered: {SOURCE_META[filterSource].label}</span>}
        {searchQuery && (
          <span className="text-amber-400/70">
            search: &ldquo;{searchQuery}&rdquo;
          </span>
        )}
      </div>

      {/* Detail Panel */}
      {selectedId && (
        <MeetingDetailPanel
          messageId={selectedId}
          searchQuery={searchQuery}
          onClose={closeMeeting}
        />
      )}
    </div>
  );
}
