"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { opsFetch, opsDelete } from "@/lib/ops-api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import UnenrolledCandidates from "./UnenrolledCandidates";

interface Contact {
  id: string;
  name: string | null;
  email_address: string;
  organization: string | null;
  contact_type?: string | null;
}

// Bots, mailing lists, and unsubscribe addresses pollute the picker — none of
// them are people whose voice we'd ever enroll.
const JUNK_EMAIL_PATTERN =
  /(noreply|no-reply|donotreply|do-not-reply|unsubscribe|bounce|notification|notifications|mailer-daemon|postmaster|automated|hello@|info@|support@|team@|@unsub\.|customer\.io|@beehiiv|github\.com$|@convertkit-mail\.|@en25\.|@medallia\.|\.fbl\.|\.ngrok\.|spamproc)/i;

const UUID_LIKE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
const HEX_BLOB_NAME = /^[0-9a-f]{16,}$/i;

function isPickableContact(c: Contact): boolean {
  if (!c.name || !c.name.trim()) return false;
  if (UUID_LIKE_NAME.test(c.name) || HEX_BLOB_NAME.test(c.name)) return false;
  if (JUNK_EMAIL_PATTERN.test(c.email_address)) return false;
  if (c.contact_type === "service" || c.contact_type === "newsletter") return false;
  // tracking-shape participant rows
  if ((c.email_address.split("@")[0] || "").length > 40) return false;
  return true;
}

interface VoicePrint {
  id: string;
  contact_id: string;
  display_name: string;
  contact_name: string | null;
  email_address: string | null;
  embedder: "transformers" | "eagle" | "hf-inference";
  picovoice_version: string | null;
  sample_seconds: number | null;
  enrolled_at: string;
  enrolled_by: string | null;
}

type EnrollResult =
  | { ok: true; voicePrint: VoicePrint; percentage: number }
  | { ok: false; percentage: number; sampleSeconds: number; message: string }
  | { error: string };

const MIN_SECONDS = 20;
const TARGET_SECONDS = 45;

function fmtTime(s: string) {
  return new Date(s).toLocaleString();
}

export default function VoicePrintsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [voicePrints, setVoicePrints] = useState<VoicePrint[]>([]);
  const [selectedContact, setSelectedContact] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const [vpResp, ctResp] = await Promise.all([
      opsFetch<{ voicePrints: VoicePrint[] }>("/api/voice-prints"),
      opsFetch<{ contacts: Contact[] }>("/api/contacts"),
    ]);
    setVoicePrints(vpResp?.voicePrints || []);
    setContacts(ctResp?.contacts || []);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startRecording = useCallback(async () => {
    setError("");
    setStatus("");
    if (!selectedContact) {
      setError("Pick a contact first.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      mr.start();
      recorderRef.current = mr;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone access denied");
    }
  }, [selectedContact]);

  const stopRecording = useCallback(async () => {
    const mr = recorderRef.current;
    if (!mr) return;
    setRecording(false);
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const finalSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
    setElapsed(finalSeconds);

    await new Promise<void>((resolve) => {
      mr.onstop = () => resolve();
      mr.stop();
    });
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;

    const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || "audio/webm" });
    chunksRef.current = [];

    if (finalSeconds < MIN_SECONDS) {
      setError(`Recording was ${finalSeconds}s — need at least ${MIN_SECONDS}s of clean speech.`);
      return;
    }

    setSubmitting(true);
    setStatus("Uploading and enrolling…");
    try {
      const contact = contacts.find((c) => c.id === selectedContact);
      const displayName = contact?.name || contact?.email_address || "Speaker";
      const url = `/api/voice-prints/enroll?contactId=${encodeURIComponent(selectedContact)}&displayName=${encodeURIComponent(displayName)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      const data: EnrollResult = await res.json();
      if (!res.ok || "error" in data) {
        setError(("error" in data && data.error) || `HTTP ${res.status}`);
      } else if (!data.ok) {
        setError(`${data.message} (${Math.round(data.percentage)}% enrolled, ${Math.round(data.sampleSeconds)}s captured)`);
      } else {
        setStatus(`Enrolled ${data.voicePrint.display_name} ✓`);
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }, [contacts, selectedContact, refresh]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this voiceprint?")) return;
      const result = await opsDelete<{ ok: true }>(`/api/voice-prints/${id}`);
      if (result.ok) {
        await refresh();
      } else {
        setError(result.error);
      }
    },
    [refresh],
  );

  const { username } = useCurrentUser();
  const enrolledIds = new Set(voicePrints.map((v) => v.contact_id));
  const enrolledContacts = contacts.filter((c) => enrolledIds.has(c.id));

  // "You" detection: prefer matches inside the team domain (@staqs.io,
  // @umbadvisors.com) before falling back to the broader local-part match.
  // Otherwise a personal gmail with the same handle as the GitHub username
  // (e.g. ecgang@example.com) wins over the team email (eric@staqs.io).
  const youContactId = useMemo(() => {
    if (!username) return null;
    const u = username.toLowerCase();
    const norm = (s: string) => s.replace(/[^a-z]/g, "");
    const isTeamDomain = (email: string) => /@(staqs\.io|umbadvisors\.com)$/i.test(email);
    const localPartMatches = (email: string) => {
      const local = email.split("@")[0].toLowerCase();
      return local === u || norm(local) === norm(u);
    };

    // Pass 1: team-domain match by local part (e.g. ecgang/eric @ staqs.io).
    const teamMatch = contacts.find(
      (c) => isTeamDomain(c.email_address) && localPartMatches(c.email_address),
    );
    if (teamMatch) return teamMatch.id;

    // Pass 2: any team-domain contact with a name that contains the handle.
    const teamFuzzy = contacts.find(
      (c) =>
        isTeamDomain(c.email_address) &&
        c.name &&
        norm(c.name).includes(norm(u)),
    );
    if (teamFuzzy) return teamFuzzy.id;

    // Pass 3: anywhere — last-resort exact local-part match.
    return contacts.find((c) => localPartMatches(c.email_address))?.id || null;
  }, [contacts, username]);

  const availableContacts = useMemo(() => {
    return contacts
      .filter((c) => !enrolledIds.has(c.id))
      .filter(isPickableContact)
      .sort((a, b) => {
        // "You" first, then team (@staqs.io / @umbadvisors.com), then alpha.
        if (a.id === youContactId) return -1;
        if (b.id === youContactId) return 1;
        const aTeam = /@(staqs\.io|umbadvisors\.com)$/i.test(a.email_address);
        const bTeam = /@(staqs\.io|umbadvisors\.com)$/i.test(b.email_address);
        if (aTeam !== bTeam) return aTeam ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });
  }, [contacts, enrolledIds, youContactId]);

  return (
    <div className="px-6 py-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-light text-zinc-100 mb-1">Voice Prints</h1>
        <p className="text-xs text-zinc-500">
          Enroll team members so meeting transcripts can label speakers by name instead of <span className="font-mono">Speaker A/B/C</span>.
          Voiceprints are computed locally with WavLM (Transformers.js); no audio leaves Optimus after enrollment.
        </p>
      </div>

      {/* Unidentified speakers from voice memos — assign once, recognized forever */}
      <UnenrolledCandidates
        contacts={contacts}
        enrolledContactIds={new Set(voicePrints.map((v) => v.contact_id))}
        onChanged={refresh}
      />

      {/* Recorder */}
      <div className="border border-white/10 rounded-lg p-5 bg-white/[0.02] mb-8">
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Enroll a speaker</h2>

        <label className="block text-xs text-zinc-400 mb-1">Contact</label>
        <select
          className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-zinc-100 mb-4 focus:outline-none focus:border-violet-500/50"
          value={selectedContact}
          onChange={(e) => setSelectedContact(e.target.value)}
          disabled={recording || submitting}
        >
          <option value="">— pick a contact —</option>
          {availableContacts.map((c) => {
            const isYou = c.id === youContactId;
            const isTeam = /@(staqs\.io|umbadvisors\.com)$/i.test(c.email_address);
            const tag = isYou ? " (you)" : isTeam ? " · team" : "";
            return (
              <option key={c.id} value={c.id}>
                {c.name || c.email_address}
                {tag}
                {!isYou && !isTeam && c.organization ? ` · ${c.organization}` : ""}
                {" — "}
                {c.email_address}
              </option>
            );
          })}
        </select>

        <div className="flex items-center gap-4 mb-3">
          {!recording ? (
            <button
              onClick={startRecording}
              disabled={!selectedContact || submitting}
              className="px-4 py-2 rounded bg-rose-500/15 border border-rose-400/30 text-rose-300 text-sm hover:bg-rose-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ● Start recording
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="px-4 py-2 rounded bg-zinc-700 border border-white/20 text-zinc-100 text-sm hover:bg-zinc-600"
            >
              ■ Stop &amp; enroll
            </button>
          )}
          <span className="text-sm font-mono text-zinc-400">
            {recording ? `${elapsed}s` : elapsed > 0 ? `last: ${elapsed}s` : "—"}
          </span>
          {recording && (
            <span className="text-xs text-zinc-500">
              aim for {TARGET_SECONDS}s · clean speech, one voice, low background noise
            </span>
          )}
        </div>

        {recording && (
          <div className="h-1.5 w-full bg-white/5 rounded overflow-hidden">
            <div
              className="h-full bg-rose-400/60 transition-all"
              style={{ width: `${Math.min(100, (elapsed / TARGET_SECONDS) * 100)}%` }}
            />
          </div>
        )}

        {status && <p className="text-xs text-emerald-400 mt-3">{status}</p>}
        {error && <p className="text-xs text-rose-400 mt-3">{error}</p>}
        {submitting && <p className="text-xs text-zinc-500 mt-3">Processing audio through Eagle… (10-15s)</p>}
      </div>

      {/* Enrolled list */}
      <div>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
          Enrolled · {voicePrints.length}
        </h2>
        {voicePrints.length === 0 ? (
          <p className="text-sm text-zinc-600 italic">
            No voiceprints yet. Enroll someone above to get started.
          </p>
        ) : (
          <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden">
            {voicePrints.map((vp) => (
              <li
                key={vp.id}
                className="flex items-center justify-between px-4 py-3 bg-white/[0.02] hover:bg-white/[0.04]"
              >
                <div>
                  <div className="text-sm text-zinc-100">{vp.display_name}</div>
                  <div className="text-xs text-zinc-500">
                    {vp.email_address || vp.contact_id}
                    {vp.sample_seconds ? ` · ${Math.round(vp.sample_seconds)}s sample` : ""}
                    {" · "}
                    enrolled {fmtTime(vp.enrolled_at)}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-600">
                      {vp.embedder}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(vp.id)}
                  className="text-xs text-zinc-500 hover:text-rose-400"
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {enrolledContacts.length > 0 && (
        <p className="text-[10px] text-zinc-600 mt-6">
          Re-recording for an already-enrolled contact replaces the existing voiceprint.
        </p>
      )}
    </div>
  );
}
