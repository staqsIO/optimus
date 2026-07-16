"use client";

import { useEffect, useState, useCallback } from "react";
import { inboxGet } from "@/components/inbox/shared";
import { useToast } from "@/components/Toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceProfile {
  scope: string;
  scope_key: string | null;
  greetings: string[] | null;
  closings: string[] | null;
  formality_score: number;
  avg_length: number;
  sample_count: number;
  last_updated: string;
}

interface EditDelta {
  edit_type: string;
  edit_magnitude: string;
  recipient: string | null;
  subject: string | null;
  created_at: string;
}

interface EditRate {
  edited: number;
  total: number;
  rate: number;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VoicePage() {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [edits, setEdits] = useState<EditDelta[]>([]);
  const [editRate, setEditRate] = useState<EditRate | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const toast = useToast();

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      inboxGet("/api/voice/profiles", { signal: AbortSignal.timeout(8000) })
        .then((r) => r.json())
        .then((data) => setProfiles(data.profiles || []))
        .catch(() => setProfiles([])),
      inboxGet("/api/voice/edits", { signal: AbortSignal.timeout(8000) })
        .then((r) => r.json())
        .then((data) => {
          setEdits(data.edits || []);
          setEditRate(data.editRate || null);
        })
        .catch(() => {
          setEdits([]);
          setEditRate(null);
        }),
    ]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRebuild = async () => {
    if (!confirm("Rebuild all voice profiles? This re-analyzes edit deltas and updates all profiles.")) return;
    setRebuilding(true);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/voice/rebuild", body: {} }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(`Rebuilt ${data.profilesRebuilt} profiles from ${data.deltasAnalyzed} deltas (${data.elapsedMs}ms)`);
        refresh();
      } else {
        toast.error(data.error || "Rebuild failed");
      }
    } catch {
      toast.error("Backend unreachable");
    } finally {
      setRebuilding(false);
    }
  };

  // Separate global and recipient profiles
  const globalProfile = profiles.find((p) => p.scope === "global");
  const recipientProfiles = profiles.filter((p) => p.scope === "recipient");

  if (loading) {
    return (
      <div className="space-y-8">
        <h1 className="text-2xl font-bold">Voice</h1>
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Voice</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Writing style profiles and edit history. Mirrors the <code className="text-accent-bright">voice</code> CLI command.
          </p>
        </div>
        <button
          onClick={handleRebuild}
          disabled={rebuilding}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
        >
          {rebuilding ? "Rebuilding..." : "Rebuild Profiles"}
        </button>
      </div>

      {/* V1: Profile Cards */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Profiles</h2>
        {profiles.length === 0 ? (
          <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
            <p className="text-sm text-zinc-500">
              No profiles built yet. Connect an account and run voice training from Settings, or use{" "}
              <code className="text-accent-bright">npm run bootstrap-voice</code>.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {/* Global profile first */}
            {globalProfile && <ProfileCard profile={globalProfile} />}
            {/* Recipient profiles */}
            {recipientProfiles.map((p) => (
              <ProfileCard key={p.scope_key} profile={p} />
            ))}
          </div>
        )}
      </section>

      {/* V2: Edit Deltas Table */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent Edit Deltas</h2>
          {editRate && (
            <span className="text-sm text-zinc-400">
              14-day edit rate:{" "}
              <span className="text-zinc-200 font-medium">
                {(Number(editRate.rate) * 100).toFixed(1)}%
              </span>{" "}
              <span className="text-zinc-500">
                ({editRate.edited}/{editRate.total})
              </span>
            </span>
          )}
        </div>

        {edits.length === 0 ? (
          <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
            <p className="text-sm text-zinc-500">No edits recorded yet.</p>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left">
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Type</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Magnitude</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Recipient</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Subject</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {edits.map((e, i) => (
                  <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-2.5">
                      <EditTypeBadge type={e.edit_type} />
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                      {(Number(e.edit_magnitude) * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300 truncate max-w-[200px]">
                      {e.recipient || <span className="text-zinc-600">--</span>}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 truncate max-w-[250px] hidden sm:table-cell">
                      {e.subject || <span className="text-zinc-600">--</span>}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 whitespace-nowrap">
                      {new Date(e.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProfileCard({ profile }: { profile: VoiceProfile }) {
  const isGlobal = profile.scope === "global";
  const title = isGlobal ? "Global" : profile.scope_key || "Unknown";

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-5">
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            isGlobal
              ? "bg-accent/20 text-accent-bright"
              : "bg-zinc-700/50 text-zinc-300"
          }`}
        >
          {isGlobal ? "GLOBAL" : "RECIPIENT"}
        </span>
        {!isGlobal && (
          <span className="text-sm text-zinc-200 font-medium truncate" title={title}>
            {title}
          </span>
        )}
      </div>

      <div className="space-y-2 text-sm">
        <ProfileRow label="Samples" value={String(profile.sample_count)} />
        <ProfileRow
          label="Formality"
          value={
            <FormalityBar score={profile.formality_score} />
          }
        />
        <ProfileRow label="Avg length" value={`${profile.avg_length} words`} />
        <ProfileRow
          label="Greetings"
          value={(profile.greetings || []).join(", ") || "(none)"}
        />
        <ProfileRow
          label="Closings"
          value={(profile.closings || []).join(", ") || "(none)"}
        />
      </div>

      <div className="mt-3 pt-3 border-t border-white/5 text-xs text-zinc-500">
        Updated: {new Date(profile.last_updated).toLocaleDateString()}
      </div>
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500 shrink-0">{label}</span>
      <span className="text-zinc-300 text-right truncate">{value}</span>
    </div>
  );
}

function FormalityBar({ score }: { score: number }) {
  const num = Number(score);
  const pct = Math.round(num * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums">{num.toFixed(2)}</span>
    </div>
  );
}

const EDIT_TYPE_COLORS: Record<string, string> = {
  minor: "bg-emerald-500/20 text-emerald-400",
  tone: "bg-blue-500/20 text-blue-400",
  content: "bg-amber-500/20 text-amber-400",
  structure: "bg-purple-500/20 text-purple-400",
  major: "bg-red-500/20 text-red-400",
};

function EditTypeBadge({ type }: { type: string }) {
  const color = EDIT_TYPE_COLORS[type] || "bg-zinc-700/50 text-zinc-300";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {type || "?"}
    </span>
  );
}
