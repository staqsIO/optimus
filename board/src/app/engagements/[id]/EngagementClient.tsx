"use client";

// Force Railway deploy: chunk 3+4 audit changes (5fb211a+) appeared to
// skip the board service's path filter despite touching board/** files.
// Edit this comment to nudge a redeploy if needed.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AddProposalModal from "./AddProposalModal";
import SectionEditor from "./SectionEditor";
import ConflictResolver from "./ConflictResolver";
import AddSectionInline from "./AddSectionInline";
import AutoBuildModal from "../AutoBuildModal";
import ProposalHistory from "./ProposalHistory";
import AuditDrawer from "./AuditDrawer";
import AsyncProgressBanner from "./AsyncProgressBanner";
import ContractDraftPanel, { type LatestContract, type ApprovedProposal } from "./ContractDraftPanel";

type Engagement = {
  id: string;
  name: string;
  client: string | null;
  kind: string;
  status: string;
  is_master: boolean;
  created_at: string;
  async_status?: "ingesting" | "synthesizing" | "generating" | "drafting_contract" | null;
  async_started_at?: string | null;
  async_progress?: {
    stage?: string;
    current?: number;
    total?: number;
    label?: string;
    model?: string;
  } | null;
};

type Proposal = {
  id: string;
  title: string | null;
  kind: "draft" | "finalized" | "note";
  source_type: "paste" | "upload" | "url";
  source_uri: string | null;
  parsed_markdown: string;
  created_at: string;
};

export type Section = {
  id: string;
  section_key: string;
  title: string;
  body: string;
  ordinal: number;
  is_core: boolean;
  pin_state: "pinned" | "unpinned";
  last_human_edit_at: string | null;
  last_human_edit_by: string | null;
  provenance: string[];
};

export type Conflict = {
  id: string;
  section_id: string | null;
  summary: string;
  options: Array<{ source_proposal_id?: string; text: string; rationale?: string }>;
  status: string;
};

export type SectionProposal = {
  id: string;
  section_id: string | null;
  kind: "add" | "remove";
  summary: string;
  rationale: string | null;
  payload: {
    section_key: string;
    title: string;
    body: string;
    ordinal: number;
    is_core: boolean;
    provenance?: string[];
  };
  created_at: string;
};

type Detail = {
  engagement: Engagement;
  spec: { id: string; version: number; last_synth_at: string | null; last_synth_proposal_count: number };
  proposals: Proposal[];
  sections: Section[];
  conflicts: Conflict[];
  sectionProposals: SectionProposal[];
  masterId: string | null;
  childSpecCount: number;
  latest_contract: LatestContract;
};

const PROPOSAL_BADGE: Record<Proposal["kind"], string> = {
  draft: "bg-zinc-800 text-zinc-400",
  finalized: "bg-emerald-900/50 text-emerald-300",
  note: "bg-amber-900/40 text-amber-300",
};

export default function EngagementClient({ engagementId }: { engagementId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [autoBuildOpen, setAutoBuildOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState<null | { sectionId: string | null }>(null);
  const [synthRunning, setSynthRunning] = useState(false);
  const [synthMessage, setSynthMessage] = useState<string | null>(null);
  const [activeConflict, setActiveConflict] = useState<Conflict | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/engagements/${engagementId}`);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data: Detail = await res.json();
      setDetail(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-poll while a background job is active on this engagement (the
  // backend stamps engagement.async_status when auto-build / synth /
  // generate fires). Stops as soon as status clears.
  useEffect(() => {
    if (!detail) return;
    if (!detail.engagement.async_status) return;
    const t = setInterval(() => refresh(), 2500);
    return () => clearInterval(t);
  }, [detail, refresh]);

  // Slower poll while a contract drafted from this engagement is mid-signing.
  // Surfaces sent → viewed → signed transitions without forcing the user to
  // click refresh. Terminal states (completed / declined / expired /
  // cancelled) stop the poll; idle drafts (no signing request yet) also
  // skip it — there's nothing to watch.
  useEffect(() => {
    if (!detail?.latest_contract) return;
    if (detail.engagement.async_status) return; // covered by the fast poll above
    const c = detail.latest_contract;
    if (!c.request_id) return;
    if (c.signing_status && ["completed", "declined", "expired", "cancelled"].includes(c.signing_status)) {
      return;
    }
    const t = setInterval(() => refresh(), 20_000);
    return () => clearInterval(t);
  }, [detail, refresh]);

  const [synthVersionBefore, setSynthVersionBefore] = useState<number | null>(null);

  async function onSynthesize() {
    if (!detail) return;
    setSynthRunning(true);
    setSynthMessage("Kicking off synth…");
    try {
      const res = await fetch(`/api/engagements/${engagementId}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      const ct = res.headers.get("content-type") || "(none)";
      let data: { status?: string; version_before?: number; message?: string; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          text.trimStart().startsWith("<")
            ? `[v2] synth returned HTML (status ${res.status}). First 200 chars: ${text.slice(0, 200)}`
            : `[v2] synth returned non-JSON (status ${res.status}, content-type ${ct}). First 200 chars: ${text.slice(0, 200)}`
        );
      }
      if (!res.ok) throw new Error(data?.error || `synth returned status ${res.status}`);
      if (data.status === "synthesizing") {
        setSynthVersionBefore(data.version_before ?? detail.spec.version);
        setSynthMessage(data.message || "Synth started in the background. Watching for completion…");
      } else {
        // Unknown response shape (e.g., dry-run). Just refresh.
        setSynthMessage("Synth complete.");
        await refresh();
      }
    } catch (err) {
      setSynthMessage(`Failed: ${(err as Error).message}`);
      setSynthRunning(false);
    }
  }

  // When a synth is in flight (synthVersionBefore set), poll the engagement
  // detail every 4s. When spec.version advances, synth has landed — clear
  // the flag and surface a completion message.
  useEffect(() => {
    if (synthVersionBefore === null) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/engagements/${engagementId}`);
        if (!res.ok) return;
        const data: Detail = await res.json();
        setDetail(data);
        if (data.spec.version > synthVersionBefore) {
          setSynthVersionBefore(null);
          setSynthRunning(false);
          setSynthMessage(
            `Synth complete · spec v${data.spec.version} · ${data.sections.length} section${data.sections.length === 1 ? "" : "s"}${data.conflicts.length ? ` · ${data.conflicts.length} new conflict${data.conflicts.length === 1 ? "" : "s"}` : ""}${data.sectionProposals.length ? ` · ${data.sectionProposals.length} proposed structure change${data.sectionProposals.length === 1 ? "" : "s"}` : ""}`
          );
        }
      } catch {
        /* keep polling */
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [synthVersionBefore, engagementId]);

  async function onSectionSave(sectionId: string, newBody: string) {
    const res = await fetch(`/api/engagements/${engagementId}/sections/${sectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: newBody }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    await refresh();
  }

  async function onSectionReorder(sectionId: string, direction: "up" | "down") {
    const res = await fetch(
      `/api/engagements/${engagementId}/sections/${sectionId}/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      }
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    await refresh();
  }

  async function onSectionDelete(sectionId: string) {
    const res = await fetch(
      `/api/engagements/${engagementId}/sections/${sectionId}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      alert(`Delete failed: ${res.status} ${await res.text()}`);
      return;
    }
    await refresh();
  }

  async function onAddSection(title: string, body: string) {
    const res = await fetch(`/api/engagements/${engagementId}/sections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    await refresh();
  }

  async function onSectionProposalAction(
    proposalId: string,
    action: "accept" | "reject"
  ) {
    const res = await fetch(
      `/api/engagements/${engagementId}/section-proposals/${proposalId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }
    );
    if (!res.ok) {
      alert(`${action} failed: ${res.status} ${await res.text()}`);
      return;
    }
    await refresh();
  }

  async function onBulkSectionProposals(action: "accept" | "reject") {
    if (!confirm(`${action === "accept" ? "Accept" : "Reject"} all ${sectionProposals.length} pending structure changes?`)) return;
    const res = await fetch(
      `/api/engagements/${engagementId}/section-proposals/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }
    );
    if (!res.ok) {
      alert(`bulk ${action} failed: ${res.status} ${await res.text()}`);
      return;
    }
    await refresh();
  }

  async function onTogglePin(sectionId: string, newState: "pinned" | "unpinned") {
    const res = await fetch(`/api/engagements/${engagementId}/sections/${sectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin_state: newState }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    await refresh();
  }

  async function onResolveConflict(conflict: Conflict, optionIndex: number) {
    const chosen = conflict.options[optionIndex];
    const res = await fetch(
      `/api/engagements/${engagementId}/conflicts/${conflict.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolution: {
            chosen_option_index: optionIndex,
            chosen_source_proposal_id: chosen?.source_proposal_id || null,
            applied_text: chosen?.text || null,
          },
        }),
      }
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    setActiveConflict(null);
    await refresh();
  }

  async function onDeleteProposal(proposal: Proposal) {
    const label = proposal.title || proposal.parsed_markdown.slice(0, 60);
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    const res = await fetch(
      `/api/engagements/${engagementId}/proposals/${proposal.id}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      alert(`Delete failed: ${res.status} ${await res.text()}`);
      return;
    }
    await refresh();
  }

  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  async function onCopyMarkdown() {
    setExportBusy("copy");
    setExportMessage(null);
    try {
      const res = await fetch(`/api/engagements/${engagementId}/export.md`);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const md = await res.text();
      await navigator.clipboard.writeText(md);
      setExportMessage(`Copied ${md.length.toLocaleString()} chars to clipboard.`);
    } catch (err) {
      setExportMessage(`Copy failed: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
    }
  }

  function onDownload(format: "md" | "docx") {
    // Direct browser navigation — Content-Disposition triggers the save dialog.
    window.location.href = `/api/engagements/${engagementId}/export.${format}`;
  }

  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [approvedProposal, setApprovedProposal] = useState<ApprovedProposal | null>(null);

  async function onGenerateProposal(format: "md" | "docx" | "gdoc") {
    setExportBusy(`proposal-${format}`);
    setExportMessage(
      format === "gdoc"
        ? "Generating proposal template and creating Google Doc…"
        : "Generating proposal template…"
    );
    // Fire the request without awaiting yet, then trigger an immediate
    // refresh so we pick up the engagement.async_status the server just
    // stamped. That unlocks the existing AsyncProgressBanner + the
    // detail-page auto-poll, so the user sees a live progress indicator
    // instead of staring at a stuck button.
    const fetchPromise = fetch(`/api/engagements/${engagementId}/generate-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    });
    // Stagger a couple of refreshes — the first might fire before the
    // server has stamped the status.
    setTimeout(() => refresh(), 200);
    setTimeout(() => refresh(), 1500);
    try {
      const res = await fetchPromise;
      if (!res.ok) {
        let msg = `${res.status}`;
        try {
          const j = await res.json();
          msg = j?.error || msg;
        } catch {
          msg = (await res.text()) || msg;
        }
        throw new Error(msg);
      }
      if (format === "gdoc") {
        const data = await res.json();
        const wasCached = data?.cached === true;
        setExportMessage(`Created: ${data.title}${wasCached ? " (reused cached markdown — $0)" : ""}`);
        window.open(data.url, "_blank", "noopener");
        return;
      }
      // md / docx: turn the body into a download
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] || `proposal-template.${format}`;
      const cachedHeader = res.headers.get("x-generation-cached") === "1";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportMessage(`Downloaded ${filename}${cachedHeader ? " (reused cached markdown — $0)" : ""}.`);
    } catch (err) {
      setExportMessage(`Proposal template failed: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
      setHistoryRefresh((n) => n + 1);
    }
  }

  async function onExportGoogleDoc() {
    setExportBusy("gdoc");
    setExportMessage(null);
    try {
      const res = await fetch(`/api/engagements/${engagementId}/export/gdoc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `${res.status}`);
      setExportMessage(`Created: ${data.title}`);
      window.open(data.url, "_blank", "noopener");
    } catch (err) {
      setExportMessage(`Google Doc failed: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
    }
  }

  async function onDismissConflict(conflict: Conflict) {
    const res = await fetch(
      `/api/engagements/${engagementId}/conflicts/${conflict.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      }
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    setActiveConflict(null);
    await refresh();
  }

  if (loading) return <div className="p-6 text-sm text-zinc-500">Loading…</div>;
  if (error) return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!detail) return null;

  const asyncBanner = detail.engagement.async_status ? (
    <AsyncProgressBanner
      status={detail.engagement.async_status}
      progress={detail.engagement.async_progress || {}}
      startedAt={detail.engagement.async_started_at || null}
    />
  ) : null;

  const { engagement, spec, proposals, sections, conflicts, sectionProposals, masterId, childSpecCount } = detail;

  // Master synth is valid when EITHER manual proposals OR child engagement
  // specs exist (distillation source). Non-master always needs a proposal.
  const canSynth = engagement.is_master
    ? proposals.length > 0 || childSpecCount > 0
    : proposals.length > 0;

  // A background job (ingest, synth, generate) is running on this engagement.
  // Disable any control that would kick off MORE LLM work while it runs —
  // we don't want double-fires, wasted spend, or race conditions on the
  // spec sections.
  const jobRunning = !!engagement.async_status;
  const jobLockTitle = jobRunning
    ? `A ${engagement.async_status} job is running on this engagement — wait for it to complete.`
    : undefined;

  return (
    <div className="flex h-full overflow-hidden">
      {/* LEFT: proposals */}
      <aside className="w-72 border-r border-white/10 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10">
          <Link href="/engagements" className="text-xs text-zinc-500 hover:text-zinc-300">
            ← Engagements
          </Link>
          <div className="flex items-center gap-2 mt-2">
            {engagement.is_master && (
              <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-300 bg-amber-900/40 px-1.5 py-0.5 rounded">
                ★ Master
              </span>
            )}
            <h2 className="text-sm font-semibold text-zinc-100">{engagement.name}</h2>
          </div>
          {engagement.client && (
            <p className="text-xs text-zinc-500 mt-0.5">{engagement.client}</p>
          )}
          {engagement.is_master && (
            <p className="text-[10px] text-zinc-500 mt-2 leading-snug">
              This is the baseline. Its sections are inherited by every other engagement at synth time.
            </p>
          )}
        </div>
        <div className="px-4 py-2 border-b border-white/10 space-y-1.5">
          <button
            onClick={() => setAddModalOpen(true)}
            className="w-full px-2 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded transition-colors"
          >
            + Add proposal
          </button>
          {!engagement.is_master && (
            <button
              onClick={() => setAutoBuildOpen(true)}
              disabled={jobRunning}
              className="w-full px-2 py-1.5 text-xs bg-blue-900/40 hover:bg-blue-900/60 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 rounded transition-colors"
              title={jobRunning ? jobLockTitle : "Pull additional meetings, emails, or signals from this client into the engagement"}
            >
              + Find more sources
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {proposals.length === 0 && (
            <div className="p-4 text-xs text-zinc-500">
              No proposals yet. Add one to start building the spec.
            </div>
          )}
          {proposals.map((p) => (
            <div
              key={p.id}
              className="group px-4 py-3 border-b border-white/5 hover:bg-zinc-900/50 relative"
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${PROPOSAL_BADGE[p.kind]}`}
                >
                  {p.kind}
                </span>
                <span className="text-[10px] text-zinc-600">{p.source_type}</span>
                <button
                  onClick={() => onDeleteProposal(p)}
                  className="ml-auto text-[10px] uppercase tracking-wider text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete this proposal"
                >
                  delete
                </button>
              </div>
              <div className="text-xs text-zinc-300 line-clamp-2">
                {p.title || p.parsed_markdown.slice(0, 80)}
              </div>
              <div className="text-[10px] text-zinc-600 mt-1">
                {new Date(p.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* CENTER: spec sections */}
      <main className="flex-1 overflow-y-auto">
        {asyncBanner}
        <div className="max-w-3xl mx-auto p-6">
          <div className="mb-6">
            <div className="text-xs text-zinc-500 mb-1">
              Spec v{spec.version} ·{" "}
              {spec.last_synth_at
                ? `last synth ${new Date(spec.last_synth_at).toLocaleString()} (${spec.last_synth_proposal_count} proposals)`
                : "never synthesized"}
            </div>
            <h1 className="text-xl font-semibold text-zinc-100">
              {engagement.is_master ? "Master spec" : "Living spec"}
            </h1>
            {!engagement.is_master && (
              <p className="text-xs text-zinc-500 mt-1">
                Inherits baseline standards from the{" "}
                <Link
                  href={masterId ? `/engagements/${masterId}` : "/engagements"}
                  className="text-amber-400 hover:text-amber-300"
                >
                  Master spec
                </Link>{" "}
                at synth time.
              </p>
            )}
          </div>

          {sections.length === 0 && (
            <div className="border border-dashed border-white/10 rounded p-8 text-center text-zinc-500 text-sm">
              <p className="mb-2">No spec yet.</p>
              <p>
                {!canSynth
                  ? engagement.is_master
                    ? "Add a manual baseline proposal, or synthesize at least one client engagement, then click Re-synthesize."
                    : "Add at least one proposal, then click Re-synthesize."
                  : engagement.is_master && childSpecCount > 0 && proposals.length === 0
                    ? `Click Re-synthesize — will distill baselines from ${childSpecCount} client engagement${childSpecCount === 1 ? "" : "s"}.`
                    : "Click Re-synthesize in the right sidebar to generate the first version."}
              </p>
            </div>
          )}

          <div className="space-y-4">
            {sections.map((s, i) => (
              <SectionEditor
                key={s.id}
                section={s}
                onSave={(body) => onSectionSave(s.id, body)}
                onTogglePin={() =>
                  onTogglePin(s.id, s.pin_state === "pinned" ? "unpinned" : "pinned")
                }
                onReorder={(dir) => onSectionReorder(s.id, dir)}
                onDelete={() => onSectionDelete(s.id)}
                onShowHistory={() => setAuditOpen({ sectionId: s.id })}
                isFirst={i === 0}
                isLast={i === sections.length - 1}
              />
            ))}
          </div>

          {sections.length > 0 && (
            <AddSectionInline onAdd={onAddSection} />
          )}
        </div>
      </main>

      {/* RIGHT: actions + conflicts */}
      <aside className="w-72 border-l border-white/10 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10">
          <button
            onClick={onSynthesize}
            disabled={synthRunning || !canSynth || jobRunning}
            className="w-full px-3 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
            title={
              jobRunning
                ? jobLockTitle
                : !canSynth
                  ? engagement.is_master
                    ? "Need at least one manual proposal OR one synthesized client engagement"
                    : "Add at least one proposal first"
                  : undefined
            }
          >
            {jobRunning ? `Waiting for ${engagement.async_status}…` : synthRunning ? "Synthesizing…" : "Re-synthesize"}
          </button>
          {engagement.is_master && childSpecCount > 0 && (
            <div className="mt-2 text-[10px] text-zinc-500">
              Will distill from {childSpecCount} client engagement
              {childSpecCount === 1 ? "" : "s"}
              {proposals.length > 0 ? ` + ${proposals.length} manual proposal${proposals.length === 1 ? "" : "s"}` : ""}.
            </div>
          )}
          {synthMessage && (
            <div className="mt-2 text-[10px] text-zinc-400 break-words">{synthMessage}</div>
          )}

          {sections.length > 0 && (
            <div className="mt-3 pt-3 border-t border-white/5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                Export the spec
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={onCopyMarkdown}
                  disabled={!!exportBusy || jobRunning}
                  title={jobRunning ? jobLockTitle : undefined}
                  className="px-2 py-1.5 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                >
                  {exportBusy === "copy" ? "Copying…" : "Copy MD"}
                </button>
                <button
                  onClick={() => onDownload("md")}
                  disabled={!!exportBusy || jobRunning}
                  title={jobRunning ? jobLockTitle : undefined}
                  className="px-2 py-1.5 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                >
                  Download .md
                </button>
                <button
                  onClick={() => onDownload("docx")}
                  disabled={!!exportBusy || jobRunning}
                  title={jobRunning ? jobLockTitle : undefined}
                  className="px-2 py-1.5 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                >
                  Download .docx
                </button>
                <button
                  onClick={onExportGoogleDoc}
                  disabled={!!exportBusy || jobRunning}
                  title={jobRunning ? jobLockTitle : undefined}
                  className="px-2 py-1.5 text-[11px] text-zinc-300 bg-blue-900/40 hover:bg-blue-900/60 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                >
                  {exportBusy === "gdoc" ? "Creating…" : "Google Doc"}
                </button>
              </div>
              {exportMessage && (
                <div className="mt-2 text-[10px] text-zinc-400 break-words">{exportMessage}</div>
              )}
            </div>
          )}

          {sections.length > 0 && (
            <div className="mt-3 pt-3 border-t border-white/5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                {engagement.is_master ? "Generic proposal template" : "Tailored client proposal"}
              </div>
              <p className="text-[10px] text-zinc-600 mb-2 leading-snug">
                {engagement.is_master
                  ? "Reframe the Master spec as a client-facing proposal with [BRACKET] placeholders."
                  : "Generate a proposal tailored to this client — brackets filled from real meetings/emails where available."}
              </p>
              <div className="space-y-1.5">
                <button
                  onClick={() => onGenerateProposal("docx")}
                  disabled={!!exportBusy || jobRunning}
                  title={jobRunning ? jobLockTitle : undefined}
                  className="w-full px-2 py-1.5 text-[11px] text-zinc-200 bg-emerald-900/40 hover:bg-emerald-900/60 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                >
                  {exportBusy === "proposal-docx" ? "Generating…" : engagement.is_master ? "Generate template .docx" : "Generate tailored .docx"}
                </button>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => onGenerateProposal("md")}
                    disabled={!!exportBusy || jobRunning}
                    title={jobRunning ? jobLockTitle : undefined}
                    className="px-2 py-1.5 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                  >
                    {exportBusy === "proposal-md" ? "Generating…" : ".md"}
                  </button>
                  <button
                    onClick={() => onGenerateProposal("gdoc")}
                    disabled={!!exportBusy || jobRunning}
                    title={jobRunning ? jobLockTitle : undefined}
                    className="px-2 py-1.5 text-[11px] text-zinc-300 bg-blue-900/40 hover:bg-blue-900/60 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
                  >
                    {exportBusy === "proposal-gdoc" ? "Creating…" : "Google Doc"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <ProposalHistory
            engagementId={engagementId}
            refreshSignal={historyRefresh}
            onApprovalChange={(approved) => {
              setApprovedProposal(
                approved
                  ? {
                      id: approved.id,
                      spec_version: approved.spec_version,
                      approved_at: approved.approved_at!,
                      approved_by: approved.approved_by,
                    }
                  : null
              );
            }}
          />

          <ContractDraftPanel
            engagementId={engagementId}
            approvedProposal={approvedProposal}
            latestContract={detail.latest_contract}
            jobRunning={jobRunning}
            jobStatus={engagement.async_status || null}
            onRefresh={refresh}
          />

          <div className="mt-3 pt-3 border-t border-white/5">
            <button
              onClick={() => setAuditOpen({ sectionId: null })}
              className="w-full px-2 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-900 hover:bg-zinc-800 rounded transition-colors"
              title="See every change made to this engagement's spec"
            >
              View audit trail
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sectionProposals.length > 0 && (
            <div className="px-4 py-3 border-b border-white/10">
              <div className="flex items-center mb-2">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Proposed structure changes ({sectionProposals.length})
                </div>
                {sectionProposals.length > 1 && (
                  <div className="ml-auto flex gap-1">
                    <button
                      onClick={() => onBulkSectionProposals("accept")}
                      disabled={jobRunning}
                      title={jobRunning ? jobLockTitle : undefined}
                      className="text-[10px] uppercase tracking-wider text-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed px-1.5 py-0.5 rounded hover:bg-zinc-800"
                    >
                      accept all
                    </button>
                    <button
                      onClick={() => onBulkSectionProposals("reject")}
                      disabled={jobRunning}
                      title={jobRunning ? jobLockTitle : undefined}
                      className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed px-1.5 py-0.5 rounded hover:bg-zinc-800"
                    >
                      reject all
                    </button>
                  </div>
                )}
              </div>
              <p className="text-[10px] text-zinc-600 mb-2 leading-snug">
                Synth wants to add or remove these sections. Accept to apply, reject to keep current structure.
              </p>
              {sectionProposals.map((p) => (
                <div
                  key={p.id}
                  className="bg-zinc-900 border border-white/5 rounded p-2 mb-2"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${
                        p.kind === "add"
                          ? "bg-emerald-900/40 text-emerald-300"
                          : "bg-red-900/40 text-red-300"
                      }`}
                    >
                      {p.kind}
                    </span>
                    <span className="text-xs text-zinc-300">{p.payload.title}</span>
                  </div>
                  {p.rationale && (
                    <div className="text-[10px] text-zinc-500 mb-2">{p.rationale}</div>
                  )}
                  {p.payload.body && (
                    <details className="mb-2">
                      <summary className="text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-300">
                        {p.kind === "add" ? "preview body" : "what will be removed"}
                      </summary>
                      <div className="text-[10px] text-zinc-400 mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap bg-zinc-950 p-2 rounded border border-white/5">
                        {p.payload.body}
                      </div>
                    </details>
                  )}
                  <div className="flex gap-1">
                    <button
                      onClick={() => onSectionProposalAction(p.id, "accept")}
                      className="flex-1 px-2 py-1 text-[10px] text-white bg-emerald-700 hover:bg-emerald-600 rounded transition-colors"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => onSectionProposalAction(p.id, "reject")}
                      className="flex-1 px-2 py-1 text-[10px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="px-4 py-3 border-b border-white/10">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Open conflicts ({conflicts.length})
            </div>
            {conflicts.length === 0 && (
              <div className="text-xs text-zinc-600">No open conflicts.</div>
            )}
            {conflicts.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveConflict(c)}
                className="block w-full text-left text-xs text-zinc-300 hover:text-emerald-300 bg-zinc-900 hover:bg-zinc-800 px-2 py-2 rounded mb-1 transition-colors"
              >
                {c.summary}
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {c.options.length} option{c.options.length === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {addModalOpen && (
        <AddProposalModal
          engagementId={engagementId}
          onClose={() => setAddModalOpen(false)}
          onIngested={() => {
            setAddModalOpen(false);
            refresh();
          }}
        />
      )}

      {autoBuildOpen && (
        <AutoBuildModal
          context={{
            mode: "append",
            engagementId,
            clientName: engagement.client || engagement.name,
            engagementName: engagement.name,
          }}
          onClose={() => setAutoBuildOpen(false)}
          onAppended={refresh}
        />
      )}

      {auditOpen && (
        <AuditDrawer
          engagementId={engagementId}
          sectionId={auditOpen.sectionId}
          onClose={() => setAuditOpen(null)}
        />
      )}

      {activeConflict && (
        <ConflictResolver
          conflict={activeConflict}
          onResolve={(idx) => onResolveConflict(activeConflict, idx)}
          onDismiss={() => onDismissConflict(activeConflict)}
          onClose={() => setActiveConflict(null)}
        />
      )}
    </div>
  );
}
