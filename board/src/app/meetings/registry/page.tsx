"use client";

/**
 * /meetings/registry — Feature 007: the meeting identity layer.
 *
 * One row per canonical meeting (content.meetings), deduped across sources
 * (TLDv + Gemini-on-Drive + manual converge via calendar reconciliation) and
 * scoped per org/personal. Personal rows that also exist at org level show the
 * cross-scope link; the owner can promote their personal copy into the org's
 * shared record (explicit, supersede-with-lineage — never an auto-merge).
 */

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost, opsPatch } from "@/lib/ops-api";
import { formatDate } from "@/lib/format";

const SOURCE_LABEL: Record<string, string> = {
  drive: "Gemini Notes",
  tldv: "TL;DV",
  mcp: "Manual / MCP",
};

interface MeetingRow {
  id: string;
  meeting_fingerprint: string;
  fingerprint_confidence: "calendar" | "derived" | "weak";
  title: string | null;
  started_at: string | null;
  calendar_event_id: string | null;
  owner_org_id: string;
  owner_id: string | null;
  primary_transcript_id: string | null;
  primary_summary_id: string | null;
  status: string;
  artifact_count: number;
  has_visible_peer: boolean;
}

interface MeetingArtifact {
  id: string;
  kind: string;
  title: string | null;
  source_system: string | null;
  status: string;
  updated_at: string;
}

interface MeetingPeer {
  id: string;
  owner_org_id: string;
  owner_id: string | null;
  status: string;
  fingerprint_confidence: string;
}

interface DetailResponse {
  meeting: MeetingRow & { participants: { email?: string; name?: string }[] };
  artifacts: MeetingArtifact[];
  peers: MeetingPeer[];
}

const CONFIDENCE_STYLE: Record<string, string> = {
  calendar: "text-emerald-400 border-emerald-400/30",
  derived: "text-sky-400 border-sky-400/30",
  weak: "text-amber-400 border-amber-400/30",
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${CONFIDENCE_STYLE[confidence] || "text-zinc-400 border-white/10"}`}
      title={
        confidence === "calendar"
          ? "Anchored to a calendar event — sources converge here"
          : confidence === "derived"
            ? "Identity from real attendee emails"
            : "Weak identity (no calendar match yet) — never auto-merged"
      }
    >
      {confidence}
    </span>
  );
}

function ScopeBadge({ ownerId }: { ownerId: string | null }) {
  return ownerId ? (
    <span className="text-[10px] px-1.5 py-0.5 rounded border text-violet-300 border-violet-400/30">personal</span>
  ) : (
    <span className="text-[10px] px-1.5 py-0.5 rounded border text-zinc-400 border-white/10">org</span>
  );
}

function MeetingDetail({ id, onPromoted }: { id: string; onPromoted: () => void }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDetail(await opsFetch<DetailResponse>(`/api/meeting-registry/${id}`));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (!detail) return <p className="text-xs text-zinc-500 px-3 py-2">Loading…</p>;
  const { meeting, artifacts, peers } = detail;
  const isPersonal = !!meeting.owner_id;

  const promote = async () => {
    setPromoting(true);
    setPromoteError(null);
    const res = await opsPost(`/api/meeting-registry/${id}/promote`);
    setPromoting(false);
    if (!res.ok) {
      setPromoteError(res.error);
      return;
    }
    onPromoted();
  };

  return (
    <div className="px-3 py-2 space-y-2 bg-zinc-950/50">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span className="font-mono">{meeting.meeting_fingerprint}</span>
        {meeting.calendar_event_id && <span>· calendar: {meeting.calendar_event_id}</span>}
      </div>

      {artifacts.length > 0 && (
        <div className="space-y-1">
          {artifacts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs">
              <span className="text-zinc-400 w-16">{a.kind}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border text-zinc-400 border-white/10">
                {a.source_system || "?"}
              </span>
              <span className="text-zinc-300 truncate flex-1">{a.title || "(untitled)"}</span>
              {(a.id === meeting.primary_transcript_id || a.id === meeting.primary_summary_id) && (
                <span className="text-[10px] text-emerald-400" title="Canonical pick (source precedence)">primary</span>
              )}
            </div>
          ))}
        </div>
      )}

      {peers.length > 0 && (
        <div className="text-[11px] text-zinc-400">
          {isPersonal
            ? "Also captured at org level — promoting merges your copy into the org record."
            : `A personal copy of this meeting also exists (${peers.length}).`}
        </div>
      )}

      {isPersonal && meeting.status === "active" && (
        <div className="flex items-center gap-2">
          <button
            onClick={promote}
            disabled={promoting}
            className="text-xs px-2 py-1 rounded border border-violet-400/30 text-violet-300 hover:bg-violet-400/10 transition-colors disabled:opacity-50"
          >
            {promoting ? "Promoting…" : "Promote to org"}
          </button>
          <span className="text-[10px] text-zinc-600">
            shares your personal copy with the org (kept as lineage, not deleted)
          </span>
          {promoteError && <span className="text-[11px] text-red-400">{promoteError}</span>}
        </div>
      )}
    </div>
  );
}

interface PrecedenceLayers {
  ok: boolean;
  system_default: string[];
  org: string[] | null;
  user: string[] | null;
  effective: string[];
  source_kinds: string[];
}

/**
 * Source-priority editor. The "primary" transcript/summary a meeting shows is
 * picked by source precedence (D4). A board member sets the org default; any
 * member can set a personal override that wins for their own meetings.
 */
function SourcePriorityEditor() {
  const [open, setOpen] = useState(false);
  const [layers, setLayers] = useState<PrecedenceLayers | null>(null);
  const [scope, setScope] = useState<"user" | "org">("user");
  const [order, setOrder] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await opsFetch<PrecedenceLayers>("/api/meeting-registry/source-precedence");
    if (data) {
      setLayers(data);
      // Seed the editor from the layer being edited, falling back down the chain.
      const seed = (scope === "org" ? data.org : data.user) || data.effective;
      // Always show ALL known source kinds; listed ones keep their order, the
      // rest append (they sort last anyway).
      const rest = data.source_kinds.filter((k) => !seed.includes(k));
      setOrder([...seed, ...rest]);
    }
  }, [scope]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  const save = async (clear = false) => {
    setSaving(true);
    setMsg(null);
    const res = await opsPatch<{ recomputed: number }>("/api/meeting-registry/source-precedence", {
      scope,
      precedence: clear ? null : order,
    });
    setSaving(false);
    if (!res.ok) { setMsg(res.error); return; }
    setMsg(clear
      ? "Reverted to the inherited default."
      : `Saved — re-picked ${res.data?.recomputed ?? 0} meeting${res.data?.recomputed === 1 ? "" : "s"}.`);
    await load();
  };

  const overrideSet = scope === "org" ? !!layers?.org : !!layers?.user;

  return (
    <div className="border border-white/5 rounded-lg">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="text-xs font-medium text-zinc-300">Source priority</span>
        <span className="text-[11px] text-zinc-500">
          which capture wins as the meeting&apos;s primary transcript
        </span>
        {layers && (
          <span className="text-[10px] text-zinc-600 truncate">
            effective: {layers.effective.map((k) => SOURCE_LABEL[k] || k).join(" › ")}
          </span>
        )}
        <span className="ml-auto text-zinc-500 text-xs">{open ? "▾" : "▸"}</span>
      </button>

      {open && layers && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-white/5">
          <div className="flex items-center gap-1 text-[11px]">
            {(["user", "org"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2 py-0.5 rounded transition-colors ${
                  scope === s ? "bg-violet-600 text-white" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                }`}
              >
                {s === "user" ? "My preference" : "Org default"}
              </button>
            ))}
            <span className="text-[10px] text-zinc-600 ml-1">
              {scope === "org"
                ? "applies to everyone in the org who has no preference of their own (board only)"
                : "wins for your own meetings"}
            </span>
          </div>

          <ol className="space-y-1">
            {order.map((k, i) => (
              <li key={k} className="flex items-center gap-2 text-xs bg-zinc-900 border border-white/5 rounded px-2 py-1.5">
                <span className="text-zinc-500 w-4 text-right">{i + 1}</span>
                <span className="text-zinc-200 flex-1">{SOURCE_LABEL[k] || k}</span>
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="text-zinc-500 hover:text-zinc-200 disabled:opacity-20 px-1"
                  aria-label="move up"
                >↑</button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === order.length - 1}
                  className="text-zinc-500 hover:text-zinc-200 disabled:opacity-20 px-1"
                  aria-label="move down"
                >↓</button>
              </li>
            ))}
          </ol>

          <div className="flex items-center gap-2">
            <button
              onClick={() => save(false)}
              disabled={saving}
              className="text-xs px-2 py-1 rounded border border-violet-400/30 text-violet-300 hover:bg-violet-400/10 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : `Save ${scope === "org" ? "org default" : "my preference"}`}
            </button>
            {overrideSet && (
              <button
                onClick={() => save(true)}
                disabled={saving}
                className="text-xs px-2 py-1 rounded border border-white/10 text-zinc-400 hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Reset to inherited
              </button>
            )}
            <span className="text-[10px] text-zinc-600">
              system default: {layers.system_default.map((k) => SOURCE_LABEL[k] || k).join(" › ")}
            </span>
            {msg && <span className="text-[11px] text-zinc-400 ml-auto">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MeetingRegistryPage() {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await opsFetch<{ meetings: MeetingRow[] }>("/api/meeting-registry?limit=100");
    setMeetings(data?.meetings || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-zinc-200">Meeting Registry</h1>
        <span className="text-[11px] text-zinc-500">
          one row per meeting — sources converge, personal vs org stays consented
        </span>
        <button onClick={load} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          refresh
        </button>
      </div>

      <SourcePriorityEditor />

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : meetings.length === 0 ? (
        <div className="text-sm text-zinc-600 border border-white/5 rounded-lg p-6 text-center">
          No meetings in the registry yet — captures land here as transcripts arrive
        </div>
      ) : (
        <div className="border border-white/5 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/5 text-zinc-500">
                <th className="text-left px-3 py-2 font-medium">Meeting</th>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Scope</th>
                <th className="text-left px-3 py-2 font-medium">Identity</th>
                <th className="text-right px-3 py-2 font-medium">Captures</th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => (
                <>
                  <tr
                    key={m.id}
                    onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                    className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2 text-zinc-200">
                      <span className="truncate">{m.title || "(untitled)"}</span>
                      {m.owner_id && m.has_visible_peer && (
                        <span className="ml-2 text-[10px] text-violet-300" title="The same meeting also exists at org level">
                          ⇄ org
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{m.started_at ? formatDate(m.started_at) : "—"}</td>
                    <td className="px-3 py-2"><ScopeBadge ownerId={m.owner_id} /></td>
                    <td className="px-3 py-2"><ConfidenceBadge confidence={m.fingerprint_confidence} /></td>
                    <td className="px-3 py-2 text-right text-zinc-400">{m.artifact_count}</td>
                  </tr>
                  {expanded === m.id && (
                    <tr key={`${m.id}-detail`} className="border-b border-white/5">
                      <td colSpan={5} className="p-0">
                        <MeetingDetail id={m.id} onPromoted={() => { setExpanded(null); load(); }} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
