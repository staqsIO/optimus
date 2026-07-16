"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SigningAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

interface CohortMember {
  id: string;
  is_self: boolean;
  display: string;
  status: "pending" | "viewed" | "signed" | "declined" | "expired";
  signing_order: number | null;
  completed_at: string | null;
}

interface SigningData {
  valid: boolean;
  error?: string;
  title?: string;
  message?: string;
  signerName?: string;
  signerEmail?: string;
  expiresAt?: string;
  documentBody?: string;
  documentTitle?: string;
  attachments?: SigningAttachment[];
  signingMode?: "parallel" | "sequential" | null;
  cohort?: CohortMember[];
}

// Average adult reading rate, words per minute. Used for the reading-time
// estimate in the header — same number Medium uses, conservative end of the
// range so the estimate doesn't look cocky to slow readers.
const READING_WPM = 220;

function estimateReadingMinutes(text: string): number {
  if (!text) return 0;
  const wordCount = (text.replace(/<[^>]+>/g, " ").match(/\S+/g) || []).length;
  return Math.max(1, Math.ceil(wordCount / READING_WPM));
}

const CONSENT_TEXT =
  "I agree to electronically sign this document. I understand that my electronic signature has the same legal effect as a handwritten signature under the ESIGN Act and UETA.";

const OPS_API = process.env.NEXT_PUBLIC_OPS_API_URL || "";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SigningPage() {
  const params = useParams();
  const token = params.token as string;

  const [data, setData] = useState<SigningData | null>(null);
  const [loading, setLoading] = useState(true);
  const [typedName, setTypedName] = useState("");
  const [consented, setConsented] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Proposal (redline / comment) form
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [proposalType, setProposalType] = useState<"comment" | "redline">("comment");
  const [proposalQuoted, setProposalQuoted] = useState("");
  const [proposalProposed, setProposalProposed] = useState("");
  const [proposalNote, setProposalNote] = useState("");
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [proposalsSubmitted, setProposalsSubmitted] = useState(0);
  const [proposalError, setProposalError] = useState<string | null>(null);

  // Own-proposal threads (this signer's past proposals + reply history)
  interface OwnReply { id: string; actor: "board" | "signer"; actor_display: string | null; message: string; created_at: string; }
  interface OwnProposal {
    id: string; proposal_type: "comment" | "redline";
    quoted_text: string | null; proposed_text: string | null; note: string | null;
    status: string; resolved_by: string | null; resolved_at: string | null; resolution_note: string | null;
    created_at: string;
    replies: OwnReply[];
  }
  const [ownProposals, setOwnProposals] = useState<OwnProposal[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Reading progress 0..1 from the document scroll container. Sticky bar at
  // top of the page fills as the signer reads, giving them a sense of how
  // much is left without the dread of an uncountable wall of text.
  const [progress, setProgress] = useState(0);

  // Reading-time estimate based on word count. Memoized off the body so it
  // doesn't recompute on every render.
  const readingMinutes = useMemo(
    () => estimateReadingMinutes(data?.documentBody || ""),
    [data?.documentBody]
  );

  // Fetch signing data
  useEffect(() => {
    if (!token) return;
    fetch(`${OPS_API}/api/sign/${token}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => { setData({ valid: false, error: "Failed to load document" }); setLoading(false); });
  }, [token]);

  // Fetch the signer's own proposals + replies so they can see any board
  // responses that came in since they last visited.
  const loadOwnProposals = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${OPS_API}/api/sign/${token}/proposals`);
      if (!res.ok) return;
      const d = await res.json();
      setOwnProposals(d?.proposals || []);
    } catch { /* non-fatal */ }
  }, [token]);

  useEffect(() => { loadOwnProposals(); }, [loadOwnProposals, proposalsSubmitted]);

  async function sendReplyToBoard(proposalId: string) {
    const msg = (replyDrafts[proposalId] || "").trim();
    if (!msg) return;
    setSendingReply(proposalId);
    try {
      const res = await fetch(`${OPS_API}/api/sign/${token}/proposals/${proposalId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (res.ok) {
        setReplyDrafts((d) => ({ ...d, [proposalId]: "" }));
        loadOwnProposals();
      }
    } finally {
      setSendingReply(null);
    }
  }

  // IntersectionObserver: unlock signing area after 90% scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setUnlocked(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [data]);

  // Reading-progress tracker. Listens to the document scroll container,
  // computes a 0..1 ratio, and updates state on scroll. Throttled via
  // requestAnimationFrame so we don't burn cycles on every wheel tick.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const max = el.scrollHeight - el.clientHeight;
        const ratio = max <= 0 ? 1 : Math.min(1, Math.max(0, el.scrollTop / max));
        setProgress(ratio);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // initial — short docs that don't need scrolling read 100%
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [data]);

  // Submit a proposal (comment or redline) without signing
  const handleSubmitProposal = useCallback(async () => {
    if (submittingProposal) return;
    setProposalError(null);

    if (proposalType === "redline" && (!proposalQuoted.trim() || !proposalProposed.trim())) {
      setProposalError("Redlines need both the current text and your suggested replacement.");
      return;
    }
    if (!proposalQuoted.trim() && !proposalNote.trim()) {
      setProposalError("Add a note or quote the section you're asking about.");
      return;
    }

    setSubmittingProposal(true);
    try {
      const res = await fetch(`${OPS_API}/api/sign/${token}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposal_type: proposalType,
          quoted_text: proposalQuoted.trim() || null,
          proposed_text: proposalType === "redline" ? proposalProposed : null,
          note: proposalNote.trim() || null,
        }),
      });
      const result = await res.json();
      if (res.ok && result.ok) {
        setProposalsSubmitted((n) => n + 1);
        setProposalQuoted("");
        setProposalProposed("");
        setProposalNote("");
        setShowProposalForm(false);
      } else {
        setProposalError(result.error || "Could not submit. Please try again.");
      }
    } catch {
      setProposalError("Network error. Please try again.");
    }
    setSubmittingProposal(false);
  }, [submittingProposal, proposalType, proposalQuoted, proposalProposed, proposalNote, token]);

  // Submit signature
  const handleSign = useCallback(async () => {
    if (!typedName.trim() || !consented || signing) return;
    setSigning(true);
    setError(null);

    try {
      const res = await fetch(`${OPS_API}/api/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typedName: typedName.trim() }),
      });
      const result = await res.json();
      if (result.success) {
        setSigned(true);
      } else {
        setError(result.error || "Signing failed");
      }
    } catch {
      setError("Network error. Please try again.");
    }
    setSigning(false);
  }, [typedName, consented, signing, token]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading document...</div>
      </div>
    );
  }

  // Error state
  if (!data?.valid) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-zinc-200 mb-2">Unable to Load Document</h1>
          <p className="text-sm text-zinc-400">{data?.error || "This signing link is invalid or has expired."}</p>
        </div>
      </div>
    );
  }

  // Signed confirmation
  if (signed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
        {/* Soft radial wash so the seal looks like it's spotlit */}
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-radial from-amber-500/10 via-transparent to-transparent"
          style={{ background: "radial-gradient(circle at 50% 35%, rgba(245, 158, 11, 0.12) 0%, transparent 60%)" }}
          aria-hidden
        />
        <div className="max-w-md text-center relative">
          {/* Animated seal: ring scribes itself, then check draws, then expanding pulse */}
          <div className="w-24 h-24 mx-auto mb-5 relative">
            <svg viewBox="0 0 100 100" className="w-full h-full">
              <defs>
                <linearGradient id="seal-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="rgb(252 211 77)" />
                  <stop offset="100%" stopColor="rgb(245 158 11)" />
                </linearGradient>
              </defs>
              {/* Pulse */}
              <circle cx="50" cy="50" r="44" fill="none" stroke="rgb(245 158 11)" strokeOpacity="0.5" strokeWidth="1">
                <animate attributeName="r" from="40" to="60" dur="1.4s" begin="0.5s" repeatCount="2" />
                <animate attributeName="stroke-opacity" from="0.6" to="0" dur="1.4s" begin="0.5s" repeatCount="2" />
              </circle>
              {/* Ring */}
              <circle
                cx="50" cy="50" r="42"
                fill="none"
                stroke="url(#seal-grad)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="264"
                strokeDashoffset="264"
                style={{ animation: "seal-ring 600ms ease-out forwards" }}
              />
              {/* Check */}
              <path
                d="M30 52 L45 67 L72 38"
                fill="none"
                stroke="url(#seal-grad)"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="80"
                strokeDashoffset="80"
                style={{ animation: "seal-check 400ms ease-out 500ms forwards" }}
              />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-zinc-100 mb-1" style={{ animation: "fade-up 500ms 700ms both" }}>
            Document Signed
          </h1>
          <p className="text-sm text-zinc-400 mb-1" style={{ animation: "fade-up 500ms 800ms both" }}>
            Signed by <span className="text-amber-300">{typedName}</span>
          </p>
          <p className="text-xs text-zinc-500 mb-5" style={{ animation: "fade-up 500ms 900ms both" }}>
            {new Date().toLocaleString()} — A copy is on its way to {data.signerEmail}
          </p>
          <div
            className="text-3xl text-amber-300 mb-5 inline-block"
            style={{ fontFamily: "'Dancing Script', cursive", animation: "ink-stroke 900ms 1000ms both" }}
          >
            {typedName}
          </div>
          <p className="text-xs text-zinc-600" style={{ animation: "fade-up 500ms 1500ms both" }}>
            You may close this window. Your signature has been recorded on a
            tamper-evident audit chain.
          </p>
        </div>
        <style jsx global>{`
          @keyframes seal-ring  { to { stroke-dashoffset: 0; } }
          @keyframes seal-check { to { stroke-dashoffset: 0; } }
          @keyframes fade-up    { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes ink-stroke { from { opacity: 0; clip-path: inset(0 100% 0 0); } to { opacity: 1; clip-path: inset(0 0 0 0); } }
        `}</style>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Sticky reading-progress bar at the very top — fills as the signer
          scrolls. Doubles as a "you've reached the end" cue when full. */}
      <div className="sticky top-0 z-20 h-0.5 bg-zinc-900/80 backdrop-blur">
        <div
          className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-[width] duration-150 ease-out"
          style={{ width: `${(progress * 100).toFixed(2)}%` }}
          aria-hidden
        />
      </div>

      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-zinc-100 truncate">{data.documentTitle || data.title}</h1>
            {data.message && (
              <p className="text-xs text-zinc-500 mt-0.5">{data.message}</p>
            )}
          </div>
          {/* Branded lockup — small monogram + wordmark. Replaces the bare
              "UMB Advisors" text label that was there before. */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-[10px] font-bold text-zinc-950 tracking-tight">
              UMB
            </div>
            <div className="leading-tight hidden sm:block">
              <div className="text-[11px] font-semibold text-zinc-200">UMB Advisors</div>
              <div className="text-[9px] text-zinc-500">Operations Board</div>
            </div>
          </div>
        </div>
      </header>

      {/* Trust + context indicators */}
      <div className="border-b border-zinc-800/50 px-6 py-2">
        <div className="max-w-3xl mx-auto flex flex-wrap gap-2 items-center">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] rounded-full bg-zinc-800/60 border border-zinc-700 text-zinc-400">
            <svg className="w-3 h-3 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Prepared for {data.signerName}
          </span>
          {readingMinutes > 0 && (
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] rounded-full bg-zinc-800/60 border border-zinc-700 text-zinc-400"
              title="Estimated time to read at 220 words/minute"
            >
              <svg className="w-3 h-3 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              ~{readingMinutes} min read
            </span>
          )}
          {data.expiresAt && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] rounded-full bg-zinc-800/60 border border-zinc-700 text-zinc-400">
              <svg className="w-3 h-3 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Expires {new Date(data.expiresAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {/* Multi-signer step indicator — only when there's more than one signer
          on the request. Shows where this signer falls in the cohort, what
          the others are doing, and (for sequential signing) whether anyone
          is ahead of them. */}
      {data.cohort && data.cohort.length > 1 && (
        <div className="border-b border-zinc-800/50 px-6 py-2.5">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">
                {data.signingMode === "sequential" ? "Sequential signing" : "Signers"}
              </span>
              <span className="text-[9px] text-zinc-600">
                ({data.cohort.filter((c) => c.status === "signed").length} of {data.cohort.length} signed)
              </span>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {data.cohort.map((m, i) => {
                const tone =
                  m.status === "signed"   ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
                  m.status === "declined" ? "bg-red-500/15 text-red-300 border-red-500/30" :
                  m.is_self               ? "bg-amber-500/15 text-amber-200 border-amber-500/40 ring-1 ring-amber-500/20" :
                                            "bg-zinc-800/60 text-zinc-400 border-zinc-700";
                return (
                  <span key={m.id} className="inline-flex items-center gap-1">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded-full border ${tone}`}
                      title={`${m.display} — ${m.status}${m.completed_at ? ` · ${new Date(m.completed_at).toLocaleString()}` : ""}`}
                    >
                      {data.signingMode === "sequential" && m.signing_order !== null && (
                        <span className="text-[9px] opacity-70">{m.signing_order}.</span>
                      )}
                      <span className="max-w-[140px] truncate">{m.display}</span>
                      <span className="opacity-70">·</span>
                      <span className="opacity-90">
                        {m.status === "signed"   ? "✓ signed" :
                         m.status === "declined" ? "declined" :
                         m.is_self               ? "you" :
                         m.status === "viewed"   ? "viewing" :
                                                   "waiting"}
                      </span>
                    </span>
                    {i < data.cohort!.length - 1 && data.signingMode === "sequential" && (
                      <span className="text-zinc-700 text-[10px] mx-0.5">→</span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Document body */}
      <div className="flex-1 overflow-hidden px-6 py-6">
        <div
          ref={scrollContainerRef}
          className="max-w-3xl mx-auto overflow-y-auto max-h-[60vh] rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:p-8"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {/* Scroll hint */}
          {!unlocked && (
            <div className="sticky top-0 z-10 -mx-6 md:-mx-8 -mt-6 md:-mt-8 mb-4 px-4 py-2 bg-gradient-to-b from-zinc-900 to-transparent text-center">
              <span className="text-[10px] text-zinc-500">↓ Scroll through the document to sign</span>
            </div>
          )}

          <div
            className="prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(data.documentBody || "") }}
          />

          {/* Exhibits / attachments */}
          {data.attachments && data.attachments.length > 0 && (
            <div className="mt-8 pt-6 border-t border-zinc-800">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                Exhibits &amp; Attachments
              </h3>
              <p className="text-[11px] text-zinc-500 mb-4">
                The following documents are incorporated by reference into this agreement.
                Click to download and review before signing.
              </p>
              <div className="space-y-2">
                {data.attachments.map((att) => (
                  <a
                    key={att.id}
                    href={`${OPS_API}/api/sign/${token}/attachments/${att.id}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800/80 hover:border-amber-500/40 transition-colors group"
                  >
                    <span className="text-lg shrink-0">
                      {att.mime_type.startsWith("image/") ? "🖼️" :
                       att.mime_type === "application/pdf" ? "📄" :
                       /\.(xlsx?|csv)$/i.test(att.filename) ? "📊" :
                       /\.docx?$/i.test(att.filename) ? "📝" : "📎"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-zinc-200 truncate group-hover:text-amber-300">
                        {att.filename}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {att.size_bytes < 1024 * 1024
                          ? `${(att.size_bytes / 1024).toFixed(1)} KB`
                          : `${(att.size_bytes / 1024 / 1024).toFixed(1)} MB`}
                      </div>
                    </div>
                    <span className="text-zinc-600 group-hover:text-amber-400 text-sm shrink-0">↓</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Sentinel for scroll detection */}
          <div ref={sentinelRef} className="h-1" />
        </div>
      </div>

      {/* Signing area */}
      <div
        className={`border-t border-zinc-800 px-6 py-6 transition-all duration-500 ${
          unlocked ? "opacity-100" : "opacity-40 pointer-events-none"
        }`}
      >
        <div className="max-w-3xl mx-auto space-y-4">
          {/* Consent checkbox */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50"
            />
            <span className="text-xs text-zinc-400 leading-relaxed">{CONSENT_TEXT}</span>
          </label>

          {/* Name input + signature preview */}
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Type your full legal name</label>
            <input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={data.signerName || "Your full name"}
              className="w-full px-4 py-2.5 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
            />
          </div>

          {/* Signature preview */}
          {typedName.trim() && (
            <div className="py-3">
              <div
                className="text-3xl text-amber-300 border-b border-zinc-700 pb-2 mb-1"
                style={{ fontFamily: "'Dancing Script', cursive" }}
              >
                {typedName}
              </div>
              <div className="text-[10px] text-zinc-500">
                {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
              </div>
            </div>
          )}

          {/* Proposals-submitted confirmation */}
          {proposalsSubmitted > 0 && ownProposals.length === 0 && (
            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              {proposalsSubmitted === 1 ? "Your suggestion" : `${proposalsSubmitted} suggestions`} sent to the sender.
            </div>
          )}

          {/* Own proposals + reply threads. Visible once the signer has
              submitted anything; shows status + board replies + compose box. */}
          {ownProposals.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-[11px] font-semibold text-amber-200">Your proposals</h4>
                  <p className="text-[10px] text-zinc-500">
                    Sender replies land here. You can sign, wait, or {" "}
                    <button
                      onClick={() => setShowProposalForm(true)}
                      className="underline underline-offset-2 hover:text-amber-300"
                    >
                      raise a new one
                    </button>.
                  </p>
                </div>
              </div>

              {ownProposals.map((p) => (
                <div key={p.id} className="rounded border border-zinc-800 bg-zinc-950/60 p-2.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${
                      p.status === "open"       ? "bg-amber-500/20 text-amber-300" :
                      p.status === "accepted"   ? "bg-emerald-500/20 text-emerald-300" :
                      p.status === "dismissed"  ? "bg-zinc-700/60 text-zinc-400" :
                                                  "bg-zinc-700/60 text-zinc-500"
                    }`}>
                      {p.status}
                    </span>
                    <span className={`px-1.5 py-0.5 text-[9px] rounded ${
                      p.proposal_type === "redline" ? "bg-violet-500/15 text-violet-300" : "bg-sky-500/15 text-sky-300"
                    }`}>
                      {p.proposal_type}
                    </span>
                    <span className="text-[9px] text-zinc-600">
                      {new Date(p.created_at).toLocaleString()}
                    </span>
                  </div>
                  {p.quoted_text && (
                    <pre className="text-[10px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 mb-1 whitespace-pre-wrap break-words font-mono max-h-[80px] overflow-y-auto">
                      {p.quoted_text}
                    </pre>
                  )}
                  {p.note && <div className="text-[11px] text-zinc-300 italic mb-1">“{p.note}”</div>}

                  {/* Reply thread */}
                  {p.replies.length > 0 && (
                    <div className="mt-2 space-y-1.5 border-t border-zinc-800 pt-2">
                      {p.replies.map((r) => (
                        <div
                          key={r.id}
                          className={`rounded border px-2 py-1.5 ${
                            r.actor === "board"
                              ? "border-sky-500/30 bg-sky-500/5"
                              : "border-zinc-700 bg-zinc-900/50"
                          }`}
                        >
                          <div className="text-[9px] mb-0.5">
                            <span className={r.actor === "board" ? "text-sky-300" : "text-zinc-400"}>
                              {r.actor_display || r.actor} · {r.actor === "board" ? "Sender" : "You"}
                            </span>
                            <span className="text-zinc-600"> · {new Date(r.created_at).toLocaleString()}</span>
                          </div>
                          <div className="text-[11px] text-zinc-300 whitespace-pre-wrap break-words">
                            {r.message}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {p.status === "open" && (
                    <div className="mt-2 flex items-end gap-2">
                      <textarea
                        value={replyDrafts[p.id] || ""}
                        onChange={(e) => setReplyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                        placeholder="Reply to the sender"
                        rows={1}
                        className="flex-1 px-2 py-1 text-[11px] bg-zinc-900 border border-zinc-800 rounded resize-none text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/40"
                      />
                      <button
                        onClick={() => sendReplyToBoard(p.id)}
                        disabled={sendingReply === p.id || !(replyDrafts[p.id] || "").trim()}
                        className="px-2.5 py-1 text-[10px] font-medium rounded bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-600 shrink-0"
                      >
                        {sendingReply === p.id ? "..." : "Send"}
                      </button>
                    </div>
                  )}

                  {p.status !== "open" && p.resolution_note && (
                    <div className="mt-2 pt-1 text-[10px] text-zinc-500 italic">
                      Sender: “{p.resolution_note}”
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Inline proposal form */}
          {showProposalForm && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-amber-200">
                  Suggest changes before signing
                </h3>
                <button
                  onClick={() => { setShowProposalForm(false); setProposalError(null); }}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  cancel
                </button>
              </div>

              {/* Type toggle */}
              <div className="flex gap-1 p-1 rounded-lg bg-zinc-900/50 border border-zinc-800">
                <button
                  onClick={() => setProposalType("comment")}
                  className={`flex-1 px-3 py-1 text-[11px] font-medium rounded transition-colors ${
                    proposalType === "comment" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  Comment
                </button>
                <button
                  onClick={() => setProposalType("redline")}
                  className={`flex-1 px-3 py-1 text-[11px] font-medium rounded transition-colors ${
                    proposalType === "redline" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  Redline
                </button>
              </div>

              {/* Quoted text — optional for comments, required for redlines */}
              <div>
                <label className="block text-[10px] font-medium text-zinc-400 mb-1">
                  Section of the document {proposalType === "redline" ? "" : "(optional)"}
                </label>
                <textarea
                  value={proposalQuoted}
                  onChange={(e) => setProposalQuoted(e.target.value)}
                  placeholder={proposalType === "redline"
                    ? "Paste the exact text you want changed"
                    : "Paste a section if you're asking about something specific"}
                  rows={3}
                  className="w-full px-3 py-2 text-xs bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 font-mono"
                />
              </div>

              {/* Proposed replacement — redline only */}
              {proposalType === "redline" && (
                <div>
                  <label className="block text-[10px] font-medium text-zinc-400 mb-1">
                    What it should say instead
                  </label>
                  <textarea
                    value={proposalProposed}
                    onChange={(e) => setProposalProposed(e.target.value)}
                    placeholder="Your suggested replacement"
                    rows={3}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 font-mono"
                  />
                </div>
              )}

              {/* Note */}
              <div>
                <label className="block text-[10px] font-medium text-zinc-400 mb-1">
                  Note to the sender {proposalType === "comment" ? "" : "(optional)"}
                </label>
                <textarea
                  value={proposalNote}
                  onChange={(e) => setProposalNote(e.target.value)}
                  placeholder="Why are you asking for this change?"
                  rows={2}
                  className="w-full px-3 py-2 text-xs bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
                />
              </div>

              {proposalError && (
                <div className="text-[11px] text-red-300">{proposalError}</div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleSubmitProposal}
                  disabled={submittingProposal}
                  className="px-4 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 transition-colors"
                >
                  {submittingProposal ? "Sending..." : "Send to sender"}
                </button>
                <p className="text-[10px] text-zinc-500 leading-relaxed self-center">
                  The sender will review and either apply your change or respond. This doesn't sign the document.
                </p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Sign button — morphs into a quill stroke + shimmer while signing
              so the user sees something more deliberate than "Signing..." */}
          <button
            onClick={handleSign}
            disabled={!typedName.trim() || !consented || signing}
            className={`relative w-full py-3 text-sm font-medium rounded-lg overflow-hidden transition-all duration-200 ${
              typedName.trim() && consented
                ? "bg-amber-600 text-white hover:bg-amber-500 hover:shadow-[0_0_20px_-4px_rgba(245,158,11,0.5)]"
                : "bg-zinc-700 text-zinc-500 cursor-not-allowed"
            } ${signing ? "scale-[0.99]" : ""}`}
            aria-live="polite"
          >
            {signing ? (
              <span className="inline-flex items-center justify-center gap-2">
                {/* Animated quill — a tiny bouncing dot trio + a shimmer sweep */}
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-white/90 animate-[btn-bounce_900ms_ease-in-out_infinite]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-white/90 animate-[btn-bounce_900ms_ease-in-out_150ms_infinite]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-white/90 animate-[btn-bounce_900ms_ease-in-out_300ms_infinite]" />
                </span>
                <span>Recording your signature</span>
                <span
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background:
                      "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.18) 50%, transparent 70%)",
                    animation: "btn-shimmer 1.4s linear infinite",
                  }}
                  aria-hidden
                />
              </span>
            ) : (
              <span>Sign Document</span>
            )}
          </button>
          <style jsx global>{`
            @keyframes btn-bounce  { 0%, 60%, 100% { transform: translateY(0); opacity: 0.8; } 30% { transform: translateY(-4px); opacity: 1; } }
            @keyframes btn-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
          `}</style>

          {/* Secondary actions */}
          <div className="text-center flex items-center justify-center gap-4">
            {!showProposalForm && (
              <button
                onClick={() => setShowProposalForm(true)}
                className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
              >
                Suggest changes
              </button>
            )}
            <button
              onClick={async () => {
                const reason = prompt("Reason for declining (optional):");
                await fetch(`${OPS_API}/api/sign/${token}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "decline", reason: reason || "" }),
                });
                setData({ valid: false, error: "You have declined this document." });
              }}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Decline to sign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Simple markdown renderer (no external dep)                         */
/* ------------------------------------------------------------------ */

function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-zinc-200 mt-6 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold text-zinc-100 mt-8 mb-3">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-zinc-50 mt-8 mb-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-100">$1</strong>')
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^\- (.+)$/gm, '<li class="ml-4">$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\|(.+)\|/g, (match) => {
      const cells = match.split("|").filter(Boolean).map((c) => c.trim());
      return `<tr>${cells.map((c) => `<td class="border border-zinc-700 px-3 py-1.5 text-xs">${c}</td>`).join("")}</tr>`;
    })
    .replace(/^---$/gm, '<hr class="border-zinc-800 my-6" />');
}
