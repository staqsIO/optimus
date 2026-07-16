"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { opsFetch, opsPost, opsDelete } from "@/lib/ops-api";

interface Contact {
  id: string;
  name: string | null;
  email_address: string;
  organization: string | null;
  contact_type?: string | null;
}

interface Candidate {
  id: string;
  occurrence_count: number;
  candidate_label: string | null;
  sample_utterance: string | null;
  first_heard_at: string;
  last_heard_at: string;
  memo_count: number | null;
}

interface CatchupResponse {
  candidates: Candidate[];
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

interface Props {
  contacts: Contact[];
  enrolledContactIds: Set<string>;
  onChanged: () => void;
}

export default function UnenrolledCandidates({ contacts, enrolledContactIds, onChanged }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [contactByCandidate, setContactByCandidate] = useState<Record<string, string>>({});
  const [nameByCandidate, setNameByCandidate] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    const data = await opsFetch<CatchupResponse>("/api/voice-prints/unenrolled");
    setCandidates(data?.candidates || []);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Filter contacts: same heuristic as the main page — only humans we'd plausibly enroll.
  const pickableContacts = useMemo(() => {
    return contacts
      .filter((c) => c.name && c.name.trim())
      .filter((c) => !enrolledContactIds.has(c.id))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [contacts, enrolledContactIds]);

  const approve = useCallback(async (candidateId: string) => {
    const contactId = contactByCandidate[candidateId];
    const fallbackName = pickableContacts.find((c) => c.id === contactId)?.name || "";
    const displayName = (nameByCandidate[candidateId] || fallbackName).trim();
    if (!contactId || !displayName) {
      setError("Pick a contact and confirm a display name.");
      return;
    }
    setError("");
    setBusyId(candidateId);
    const result = await opsPost<{ ok: true }>(
      `/api/voice-prints/unenrolled/${candidateId}/approve`,
      { contact_id: contactId, display_name: displayName },
    );
    setBusyId(null);
    if (!result.ok) {
      setError(result.error || "Approve failed");
      return;
    }
    setCandidates((prev) => prev.filter((c) => c.id !== candidateId));
    onChanged();
  }, [contactByCandidate, nameByCandidate, pickableContacts, onChanged]);

  const dismiss = useCallback(async (candidateId: string) => {
    if (!confirm("Dismiss this candidate? It will be re-captured if heard again.")) return;
    setBusyId(candidateId);
    const result = await opsDelete<{ ok: true }>(`/api/voice-prints/unenrolled/${candidateId}`);
    setBusyId(null);
    if (!result.ok) {
      setError(result.error || "Dismiss failed");
      return;
    }
    setCandidates((prev) => prev.filter((c) => c.id !== candidateId));
  }, []);

  if (candidates.length === 0) return null;

  return (
    <section className="border border-amber-700/40 rounded-lg p-5 bg-amber-950/20 mb-8">
      <h2 className="text-xs uppercase tracking-wider text-amber-400/80 mb-1">
        Unidentified speakers · {candidates.length}
      </h2>
      <p className="text-xs text-zinc-500 mb-4">
        Voices captured from voice memos that don't match any enrolled print yet. Assign one to a contact and the resolver will recognize them automatically from then on — no further approval needed.
      </p>
      {error && (
        <div className="mb-3 px-3 py-2 rounded border border-red-700/40 bg-red-950/30 text-xs text-red-300">
          {error}
        </div>
      )}
      <ul className="divide-y divide-white/5">
        {candidates.map((c) => (
          <li key={c.id} className="py-3 flex flex-col gap-2 md:flex-row md:items-start md:gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono text-amber-200">
                {c.candidate_label ? `Speaker ${c.candidate_label}` : "Speaker"} · ×{c.occurrence_count}
                {c.memo_count ? ` · ${c.memo_count} memo${c.memo_count === 1 ? "" : "s"}` : ""}
                <span className="text-zinc-600 ml-2">last heard {formatRelative(c.last_heard_at)}</span>
              </div>
              {c.sample_utterance && (
                <div className="mt-1 text-sm text-zinc-300 italic">"{c.sample_utterance}"</div>
              )}
            </div>
            <div className="flex flex-col gap-2 md:w-96 shrink-0">
              <select
                className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                value={contactByCandidate[c.id] || ""}
                onChange={(e) => {
                  const newContactId = e.target.value;
                  setContactByCandidate((prev) => ({ ...prev, [c.id]: newContactId }));
                  // Pre-fill display name with the contact's name.
                  const ct = pickableContacts.find((x) => x.id === newContactId);
                  setNameByCandidate((prev) => ({ ...prev, [c.id]: ct?.name || "" }));
                }}
              >
                <option value="">— assign to contact —</option>
                {pickableContacts.map((ct) => (
                  <option key={ct.id} value={ct.id}>
                    {ct.name} — {ct.email_address}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Display name"
                className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                value={nameByCandidate[c.id] || ""}
                onChange={(e) => setNameByCandidate((prev) => ({ ...prev, [c.id]: e.target.value }))}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => approve(c.id)}
                  disabled={busyId === c.id || !contactByCandidate[c.id]}
                  className="flex-1 px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-xs hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busyId === c.id ? "approving…" : "Approve"}
                </button>
                <button
                  onClick={() => dismiss(c.id)}
                  disabled={busyId === c.id}
                  className="px-3 py-1.5 rounded border border-white/10 text-zinc-400 text-xs hover:bg-white/5 disabled:opacity-40"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
