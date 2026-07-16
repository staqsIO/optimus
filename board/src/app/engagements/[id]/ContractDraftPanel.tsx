"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type TemplateOption = {
  id: string;
  slug?: string;
  name: string;
  source?: "file" | "db";
};

export type LatestContract = {
  id: string;
  title: string;
  draft_status: string;
  request_id: string | null;
  signing_status: string | null;
  signed_count: number;
  total_signers: number;
} | null;

export type ApprovedProposal = {
  id: string;
  spec_version: number;
  approved_at: string;
  approved_by: string | null;
};

type Props = {
  engagementId: string;
  approvedProposal: ApprovedProposal | null;
  latestContract: LatestContract;
  jobRunning: boolean;
  jobStatus: string | null;
  onRefresh: () => Promise<void> | void;
};

const STATUS_PILL: Record<string, string> = {
  draft: "bg-zinc-700/50 text-zinc-200",
  review: "bg-blue-600/40 text-blue-200",
  approved: "bg-amber-600/40 text-amber-100",
  ready: "bg-amber-600/40 text-amber-100",
  published: "bg-violet-600/40 text-violet-100",
  sent: "bg-violet-600/40 text-violet-100",
  signed: "bg-emerald-600/40 text-emerald-100",
  completed: "bg-emerald-600/40 text-emerald-100",
  declined: "bg-red-600/40 text-red-100",
  expired: "bg-zinc-700/60 text-zinc-400",
  cancelled: "bg-zinc-700/60 text-zinc-400",
};

function displayStatus(c: NonNullable<LatestContract>): string {
  if (c.signing_status === "completed") return "signed";
  if (c.signing_status === "declined") return "declined";
  if (c.signing_status === "expired") return "expired";
  if (c.signing_status === "cancelled") return "cancelled";
  if (c.signing_status === "in_progress" || c.signing_status === "pending") return "sent";
  if (c.draft_status === "published") return "sent";
  if (c.draft_status === "approved") return "ready";
  return c.draft_status;
}

export default function ContractDraftPanel({
  engagementId,
  approvedProposal,
  latestContract,
  jobRunning,
  jobStatus,
  onRefresh,
}: Props) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("service-proposal");
  const [drafting, setDrafting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set true the moment the user kicks off a draft; consumed by the redirect
  // effect below so we only auto-navigate for a draft *we* initiated (not for
  // a stale contract loaded on initial page mount).
  const justInitiatedRef = useRef(false);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);

  // Auto-navigate to the contracts page once the drafter we kicked off
  // finishes (jobStatus clears AND latestContract appears). 3s countdown
  // with a Stay-here / Open-now escape — the user just asked for this work,
  // taking them to it directly is the expected next step.
  useEffect(() => {
    if (!justInitiatedRef.current) return;
    if (jobStatus === "drafting_contract") return;
    if (!latestContract?.id) return;
    setRedirectCountdown(3);
  }, [jobStatus, latestContract?.id]);

  useEffect(() => {
    if (redirectCountdown === null) return;
    if (redirectCountdown <= 0) {
      justInitiatedRef.current = false;
      const target = latestContract?.id
        ? `/contracts?selected=${latestContract.id}`
        : "/contracts";
      router.push(target);
      return;
    }
    const t = setTimeout(() => setRedirectCountdown((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [redirectCountdown, latestContract?.id, router]);

  // Load templates from the same /api/contracts/templates endpoint the
  // /contracts page uses. The board exposes it via the ops proxy.
  useEffect(() => {
    fetch("/api/ops?path=" + encodeURIComponent("/api/contracts/templates"))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.templates?.length) {
          setTemplates(data.templates);
          // Prefer service-proposal if present; else first template.
          const sp = data.templates.find((t: TemplateOption) => (t.slug || t.id) === "service-proposal");
          setSelectedTemplate(sp ? (sp.slug || sp.id) : (data.templates[0].slug || data.templates[0].id));
        }
      })
      .catch(() => { /* fall back to hardcoded options */ });
  }, []);

  if (!approvedProposal) return null;

  // Drafting is in flight whenever the engagement-level async_status is
  // 'drafting_contract'. We treat that as the source of truth so a refresh
  // after navigation away still shows the spinner.
  const drafterRunning = drafting || jobStatus === "drafting_contract";

  async function onDraft(force = false) {
    if (!approvedProposal) return;
    if (force && latestContract) {
      const ok = confirm(
        `Redraft the contract from the currently approved proposal ` +
        `(spec v${approvedProposal.spec_version})?\n\n` +
        `A new contract draft will be created. The existing one ` +
        `("${latestContract.title}") stays in history and can be ` +
        `deleted manually from the Contracts page if you don't need it.`
      );
      if (!ok) return;
    }
    setDrafting(true);
    justInitiatedRef.current = true;
    setMessage(force ? "Redrafting contract…" : "Starting contract drafter…");
    try {
      const res = await fetch(`/api/engagements/${engagementId}/draft-contract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generated_proposal_id: approvedProposal.id,
          template: selectedTemplate,
          force,
        }),
      });
      const text = await res.text();
      let data: { status?: string; message?: string; error?: string };
      try { data = JSON.parse(text); }
      catch { throw new Error(`drafter returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`); }
      if (!res.ok) throw new Error(data?.error || `drafter returned ${res.status}`);
      setMessage(data.message || "Contract drafting started.");
      // Trigger an immediate refresh so the engagement page picks up the
      // async_status stamp and shows the progress banner.
      setTimeout(() => onRefresh(), 200);
      setTimeout(() => onRefresh(), 1500);
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    } finally {
      setDrafting(false);
    }
  }

  const heading = (
    <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
      Contract
    </div>
  );

  // STATE 3 + 4 — a contract already exists. Show status + jump-to link.
  if (latestContract) {
    const status = displayStatus(latestContract);
    return (
      <div className="mt-3 pt-3 border-t border-white/5">
        {heading}
        {redirectCountdown !== null && (
          <div className="mb-2 bg-emerald-900/30 border border-emerald-500/40 rounded p-2">
            <div className="text-[11px] text-emerald-200 font-medium leading-snug">
              ✓ Contract drafted — opening in {redirectCountdown}s…
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button
                onClick={() => {
                  setRedirectCountdown(0);
                }}
                className="flex-1 px-2 py-1 text-[10px] text-white bg-emerald-600 hover:bg-emerald-500 rounded"
              >
                Open now
              </button>
              <button
                onClick={() => {
                  setRedirectCountdown(null);
                  justInitiatedRef.current = false;
                }}
                className="flex-1 px-2 py-1 text-[10px] text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded"
              >
                Stay here
              </button>
            </div>
          </div>
        )}
        <div className="bg-zinc-900 border border-white/5 rounded p-2 space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded text-[9px] ${STATUS_PILL[status] || STATUS_PILL.draft}`}
            >
              {status}
            </span>
            {latestContract.total_signers > 0 && (
              <span className="text-[10px] text-zinc-500">
                {latestContract.signed_count}/{latestContract.total_signers} signed
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-300 leading-snug">
            {latestContract.title}
          </div>
          <div className="flex gap-1.5">
            <Link
              href={`/contracts?selected=${latestContract.id}`}
              className="flex-1 text-center px-2 py-1.5 text-[11px] text-zinc-200 bg-emerald-700/50 hover:bg-emerald-700 rounded transition-colors"
            >
              Open in Contracts →
            </Link>
            {status === "ready" && (
              <Link
                href={`/contracts?selected=${latestContract.id}&open=send`}
                className="flex-1 text-center px-2 py-1.5 text-[11px] text-white bg-amber-600 hover:bg-amber-500 rounded transition-colors"
                title="Jump to Contracts page with the send-for-signature form open"
              >
                Send →
              </Link>
            )}
          </div>
          <button
            onClick={() => onDraft(true)}
            disabled={drafterRunning || jobRunning}
            className="w-full px-2 py-1.5 text-[10px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
            title="Re-run the drafter against the currently-approved proposal. Use this after uploading a hand-edited proposal so the contract reflects the updated content."
          >
            {drafterRunning ? "Drafting…" : `Redraft from approved proposal (spec v${approvedProposal.spec_version})`}
          </button>
          {message && (
            <div className="text-[10px] text-zinc-400 break-words">{message}</div>
          )}
        </div>
        {drafterRunning && (
          <div className="mt-2 text-[10px] text-zinc-400 break-words">
            A new contract draft is being generated for this engagement…
          </div>
        )}
      </div>
    );
  }

  // STATE 1 + 2 — no contract yet. Show template picker + draft button.
  return (
    <div className="mt-3 pt-3 border-t border-white/5">
      {heading}
      <p className="text-[10px] text-zinc-600 mb-2 leading-snug">
        Fold the approved proposal (v{approvedProposal.spec_version}) into a legal template. The drafter
        fills in the proposal&apos;s scope and pricing and writes out the legalese for you.
      </p>
      <select
        value={selectedTemplate}
        onChange={(e) => setSelectedTemplate(e.target.value)}
        disabled={drafterRunning || jobRunning}
        className="w-full mb-1.5 px-2 py-1.5 text-[11px] bg-zinc-800 border border-zinc-700 rounded text-zinc-200 disabled:opacity-50"
      >
        {templates.length === 0 ? (
          <>
            <option value="service-proposal">Service Proposal</option>
            <option value="sow">Statement of Work</option>
            <option value="nda">NDA</option>
          </>
        ) : (
          templates.map((t) => (
            <option key={t.id} value={t.slug || t.id}>
              {t.name}
              {t.source === "db" ? " (custom)" : ""}
            </option>
          ))
        )}
      </select>
      <button
        onClick={() => onDraft(false)}
        disabled={drafterRunning || jobRunning}
        className="w-full px-2 py-1.5 text-[11px] text-white bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
        title={
          jobRunning && !drafterRunning
            ? "Another job is running on this engagement — wait for it to finish"
            : undefined
        }
      >
        {drafterRunning ? "Drafting contract…" : "Draft contract from this proposal"}
      </button>
      {message && (
        <div className="mt-2 text-[10px] text-zinc-400 break-words">{message}</div>
      )}
    </div>
  );
}
