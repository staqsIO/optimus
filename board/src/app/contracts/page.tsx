"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { opsFetch, opsPost, opsDelete } from "@/lib/ops-api";
import dynamic from "next/dynamic";
import type { ContractEditorHandle } from "@/components/contracts/ContractEditor";
import VariablePanel from "@/components/contracts/VariablePanel";
import ContractAIBar from "@/components/contracts/ContractAIBar";
import ContractAttachments from "@/components/contracts/ContractAttachments";
import ContractVersions from "@/components/contracts/ContractVersions";
import CounterpartyPicker from "@/components/contracts/CounterpartyPicker";
import ContractProposals from "@/components/contracts/ContractProposals";
import ContractWorkItems from "@/components/contracts/ContractWorkItems";
import ContractRiskMeter from "@/components/contracts/ContractRiskMeter";
import RecipientPicker from "@/components/contracts/RecipientPicker";
import { OrgSelector } from "@/components/OrgSelector";

const ContractEditor = dynamic(() => import("@/components/contracts/ContractEditor"), { ssr: false });
import { useEventStream } from "@/hooks/useEventStream";

interface TemplateCatalogEntry {
  id: string;
  slug?: string;
  name: string;
  variables: string[];
  source?: "file" | "db";
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Contract {
  id: string;
  title: string;
  draft_status: string;
  display_status: string;
  client_name: string | null;
  counterparty_id: string | null;
  signer_name: string | null;
  signer_email: string | null;
  request_id: string | null;
  signing_status: string | null;
  signed_count: number;
  declined_count: number;
  total_signers: number;
  expires_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  word_count: number;
  cost_usd: string;
  template_id: string | null;
}

interface SignerSummary {
  id: string;
  display_name: string;
  email: string;
  status: "pending" | "viewed" | "signed" | "declined" | "expired";
  signing_order: number | null;
  completed_at: string | null;
  created_at: string;
}

interface AuditEvent {
  id: string;
  event_type: string;
  typed_name: string | null;
  signer_name: string;
  signer_email: string;
  ip_address: string | null;
  created_at: string;
}

type FilterStage = "all" | "draft" | "ready" | "sent" | "signed" | "declined";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-600/40 text-zinc-400",
  review: "bg-blue-500/20 text-blue-400",
  ready: "bg-amber-500/20 text-amber-400",
  sent: "bg-violet-500/20 text-violet-400",
  viewed: "bg-sky-500/20 text-sky-400",
  signed: "bg-emerald-500/20 text-emerald-400",
  completed: "bg-emerald-500/20 text-emerald-400",
  declined: "bg-red-500/20 text-red-400",
  expired: "bg-zinc-700/40 text-zinc-500",
  cancelled: "bg-zinc-700/40 text-zinc-500",
};

const PIPELINE_STEPS = ["draft", "review", "ready", "sent", "viewed", "signed"];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ContractsPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [selected, setSelected] = useState<Contract | null>(null);
  const [filter, setFilter] = useState<FilterStage>("all");
  const [loading, setLoading] = useState(true);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [signers, setSigners] = useState<SignerSummary[]>([]);
  const [signingMode, setSigningMode] = useState<"parallel" | "sequential" | null>(null);
  const [draftBody, setDraftBody] = useState<string>("");

  // New contract form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCounterpartyId, setNewCounterpartyId] = useState<string | null>(null);
  const [newTemplate, setNewTemplate] = useState("service-proposal");
  const [newOnBehalfOfOrgId, setNewOnBehalfOfOrgId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Variable panel
  const [usedBrackets, setUsedBrackets] = useState<string[]>([]);
  const [templatesCatalog, setTemplatesCatalog] = useState<TemplateCatalogEntry[]>([]);
  const editorRef = useRef<ContractEditorHandle>(null);

  // Ingest-proposal form (upload a .docx → extract content + branding)
  const [showIngestForm, setShowIngestForm] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const ingestInputRef = useRef<HTMLInputElement>(null);

  // Version history panel
  const [showVersions, setShowVersions] = useState(false);
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);

  // Reserved for external refresh signals (e.g. SSE on new proposal); the
  // panel self-refreshes on its own accept/dismiss actions.
  const [proposalsRefreshKey] = useState(0);

  // Send for signature form
  const [showSendForm, setShowSendForm] = useState(false);
  const [externalSigners, setExternalSigners] = useState<Array<{ name: string; email: string }>>([{ name: "", email: "" }]);
  const [internalSigners, setInternalSigners] = useState<Set<string>>(new Set());
  const [boardMembers, setBoardMembers] = useState<Array<{ github_username: string; display_name: string; email: string }>>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ signingUrls: string[] } | null>(null);

  // Suggested recipients pulled from counterparty + ingested proposals +
  // signal contacts + board members. Loaded when the send form opens.
  type SuggestedRecipient = {
    name: string;
    email: string;
    source: "primary" | "proposal" | "signal" | "internal";
    note: string | null;
    default_selected: boolean;
    github_username?: string;
  };
  type Suggestions = {
    primary: SuggestedRecipient[];
    proposal: SuggestedRecipient[];
    signal: SuggestedRecipient[];
    internal: SuggestedRecipient[];
  };
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  // Editable signer rows shown in the form. Keyed by email so a single
  // contact can't sneak into the send list twice. UI lets the user edit
  // name/email inline; we re-emit on submit.
  type EditableSigner = SuggestedRecipient & { selected: boolean };
  const [editableSigners, setEditableSigners] = useState<EditableSigner[]>([]);
  const [customEmail, setCustomEmail] = useState("");
  const [customName, setCustomName] = useState("");

  // Pre-send governance findings (G2/G7)
  interface PreSendFinding { gate: "G2" | "G7"; severity: "info" | "warn" | "block"; title: string; excerpt: string; reason: string; }
  const [preSendFindings, setPreSendFindings] = useState<PreSendFinding[] | null>(null);
  const [preSendLoading, setPreSendLoading] = useState(false);
  // Live risk meter — re-runs the same G2/G7 scan after each save while the
  // contract is still editable. Findings here are the same source of truth
  // as preSendFindings; we keep them in sync so the Send-form panel and the
  // sidebar gauge agree.
  const [lastRiskScanAt, setLastRiskScanAt] = useState<Date | null>(null);
  const riskScanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<Contract[]> => {
    const data = await opsFetch<{ contracts: Contract[] }>("/api/contracts");
    const list = data?.contracts || [];
    setContracts(list);
    setLoading(false);
    return list;
  }, []);

  // On first load, also honor a ?selected=<draftId> query param so deeplinks
  // from the engagement page (ContractDraftPanel → "Open in Contracts") land
  // directly on the right contract. Optional ?open=send auto-opens the
  // send-for-signature form so the user can ship it in one click.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await load();
      if (cancelled) return;
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      const wantId = params.get("selected");
      if (!wantId) return;
      const match = list.find((c) => c.id === wantId);
      if (match) {
        setSelected(match);
        if (params.get("open") === "send" && match.display_status === "ready") {
          // Defer until after the detail-load effect has hydrated audit/signers,
          // otherwise opening the send form races the initial pre-send check.
          setTimeout(() => setShowSendForm(true), 250);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load board members for internal signer selection
  useEffect(() => {
    opsFetch<{ members: Array<{ github_username: string; display_name: string; email: string }> }>("/api/board-members").then((d) => {
      setBoardMembers(d?.members || []);
    });
  }, []);

  // Load templates catalog once (for variable discovery)
  useEffect(() => {
    opsFetch<{ templates: TemplateCatalogEntry[] }>("/api/contracts/templates").then((d) => {
      setTemplatesCatalog(d?.templates || []);
    });
  }, []);

  // Template is now stored on the draft (migration 064). Fall back to the old
  // title heuristic only for contracts created before the column was populated.
  const currentTemplateId = useMemo(() => {
    if (selected?.template_id) return selected.template_id;
    const title = (selected?.title || "").toLowerCase();
    if (title.includes("nda") || title.includes("non-disclosure")) return "nda";
    if (title.includes("sow") || title.includes("statement of work")) return "sow";
    return "service-proposal";
  }, [selected?.template_id, selected?.title]);

  // Compute available variables = template catalog minus what's already in the doc
  const availableVars = useMemo(() => {
    const tmpl = templatesCatalog.find((t) => t.id === currentTemplateId);
    if (!tmpl) return [];
    const used = new Set(usedBrackets);
    return tmpl.variables.filter((v) => !used.has(v));
  }, [templatesCatalog, currentTemplateId, usedBrackets]);

  // SSE refresh on signing events
  useEventStream("campaign_completed", load);
  useEventStream("draft_ready", load);

  // Helpers for the live risk-meter scan. We piggy-back on the existing
  // G2/G7 scan endpoint and treat the findings as live state. A successful
  // editor save schedules a debounced rescan; bookkeeping is kept on this
  // page so multiple panels (sidebar gauge, send-form, etc.) share results.
  const runRiskScan = useCallback(async () => {
    if (!selected) return;
    if (["sent", "signed", "completed", "published", "rejected"].includes(selected.display_status)) return;
    setPreSendLoading(true);
    try {
      const r = await opsPost<{ findings: PreSendFinding[] }>(`/api/contracts/${selected.id}/pre-send-check`, {});
      if (r.ok) {
        setPreSendFindings(r.data.findings || []);
        setLastRiskScanAt(new Date());
      }
    } finally {
      setPreSendLoading(false);
    }
  }, [selected]);

  const scheduleRiskScan = useCallback((delayMs: number = 4000) => {
    if (!selected) return;
    if (["sent", "signed", "completed", "published", "rejected"].includes(selected.display_status)) return;
    if (riskScanTimerRef.current) clearTimeout(riskScanTimerRef.current);
    riskScanTimerRef.current = setTimeout(() => {
      riskScanTimerRef.current = null;
      void runRiskScan();
    }, delayMs);
  }, [selected, runRiskScan]);

  // When the deeplink auto-opens the send form (?open=send), the click
  // handler path is skipped, so also trigger suggestions + pre-send-check
  // off showSendForm becoming true. Idempotent thanks to the suggestions
  // === null guard.
  useEffect(() => {
    if (!showSendForm || !selected) return;
    if (suggestions === null && !suggestionsLoading) {
      void loadSuggestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSendForm, selected?.id]);

  // Lazy-load the four-section suggested-recipients list the first time the
  // send form opens for a given contract. We materialize them into an
  // EditableSigner array so the form can inline-edit name/email/selection.
  const loadSuggestions = useCallback(async () => {
    if (!selected) return;
    setSuggestionsLoading(true);
    try {
      const data = await opsFetch<Suggestions>(`/api/contracts/${selected.id}/suggested-recipients`);
      if (!data) {
        setSuggestions({ primary: [], proposal: [], signal: [], internal: [] });
        return;
      }
      setSuggestions(data);
      const flat: EditableSigner[] = [];
      for (const section of [data.primary, data.proposal, data.signal, data.internal]) {
        for (const r of section || []) {
          // Same email twice across sections shouldn't double-list. The
          // discovery lib already excludes the primary/proposal overlaps,
          // but signal vs primary can theoretically collide if a board
          // member shares a domain — guard here too.
          if (flat.some((x) => x.email === r.email)) continue;
          flat.push({ ...r, selected: r.default_selected });
        }
      }
      setEditableSigners(flat);
    } finally {
      setSuggestionsLoading(false);
    }
  }, [selected]);

  // Load detail when selected
  useEffect(() => {
    if (!selected) { setDraftBody(""); setAudit([]); setSigners([]); setSigningMode(null); setUsedBrackets([]); setShowVersions(false); setPreSendFindings(null); setLastRiskScanAt(null); return; }
    setShowVersions(false);
    setPreSendFindings(null);
    setLastRiskScanAt(null);
    if (riskScanTimerRef.current) { clearTimeout(riskScanTimerRef.current); riskScanTimerRef.current = null; }
    // Kick off an initial risk scan for editable contracts (slight delay so
    // it doesn't compete with body load + variable detection).
    if (!["sent", "signed", "completed", "published", "rejected"].includes(selected.display_status)) {
      // Park the timer in the same ref so a rapid select-churn can clear it.
      riskScanTimerRef.current = setTimeout(() => {
        riskScanTimerRef.current = null;
        void runRiskScan();
      }, 1200);
    }

    // Load draft body
    opsFetch<{ draft: { body: string } }>(`/api/content/drafts/${selected.id}`).then((d) => {
      setDraftBody(d?.draft?.body || "");
    });

    // Load audit trail + per-signer state if there's a signing request
    if (selected.request_id) {
      opsFetch<{
        events: AuditEvent[];
        signers: SignerSummary[];
        signingMode: "parallel" | "sequential" | null;
      }>(`/api/contracts/${selected.id}/audit`).then((d) => {
        setAudit(d?.events || []);
        setSigners(d?.signers || []);
        setSigningMode(d?.signingMode ?? null);
      });
    } else {
      setAudit([]);
      setSigners([]);
      setSigningMode(null);
    }

    setSendResult(null);
    setShowSendForm(false);
    setExternalSigners([{ name: selected?.signer_name || "", email: selected?.signer_email || "" }]);
    setInternalSigners(new Set());
    setSuggestions(null);
    setEditableSigners([]);
  }, [selected, runRiskScan]);

  // Filter contracts
  const filtered = filter === "all"
    ? contracts
    : contracts.filter((c) => {
        if (filter === "draft") return c.display_status === "draft" || c.display_status === "review";
        if (filter === "ready") return c.display_status === "ready";
        if (filter === "sent") return c.display_status === "sent" || c.display_status === "viewed";
        if (filter === "signed") return c.display_status === "signed" || c.display_status === "completed";
        if (filter === "declined") return c.display_status === "declined" || c.display_status === "expired";
        return true;
      });

  // Actions
  async function handleApprove() {
    if (!selected) return;
    if (usedBrackets.length > 0) {
      const preview = usedBrackets.slice(0, 5).map((n) => `  • [${n}]`).join("\n");
      const more = usedBrackets.length > 5 ? `\n  ...and ${usedBrackets.length - 5} more` : "";
      const ok = window.confirm(
        `⚠️ This contract has ${usedBrackets.length} unfilled placeholder${usedBrackets.length === 1 ? "" : "s"}:\n\n${preview}${more}\n\nIf you approve and send as-is, the client will see these brackets in the final document.\n\nApprove anyway?`
      );
      if (!ok) return;
    }
    await opsPost(`/api/content/drafts/${selected.id}/approve`);
    load();
    setSelected((prev) => prev ? { ...prev, draft_status: "approved", display_status: "ready" } : null);
  }

  async function handleSend() {
    if (!selected) return;
    // Editable picker is the source of truth when suggestions are loaded;
    // otherwise fall back to the legacy free-text + checkbox lists so older
    // contracts (no engagement, no counterparty) still send.
    const selectedRows = editableSigners.filter(
      (s) => s.selected && s.email.trim() && s.email.includes("@")
    );

    let allSigners: Array<{ name: string; email: string; order: number; type: string }>;

    if (selectedRows.length > 0) {
      // External-first signing order: clients sign before UMB countersigns.
      allSigners = selectedRows.map((s) => ({
        name: (s.name || s.email.split("@")[0]).trim(),
        email: s.email.trim(),
        order: s.source === "internal" ? 2 : 1,
        type: s.source === "internal" ? "internal" : "external",
      }));
    } else {
      const validExternal = externalSigners.filter((s) => s.email.trim());
      if (validExternal.length === 0 && internalSigners.size === 0) return;
      allSigners = [
        ...validExternal.map((s) => ({ name: s.name.trim(), email: s.email.trim(), order: 1, type: "external" })),
        ...Array.from(internalSigners).map((username) => {
          const member = boardMembers.find((m) => m.github_username === username);
          return {
            name: member?.display_name || username,
            email: member?.email || `${username}@staqs.io`,
            order: 2,
            type: "internal",
          };
        }),
      ];
    }
    if (allSigners.length === 0) return;
    setSending(true);

    // If the pre-send scan flagged block-severity issues, prompt for an
    // override reason up-front so /send doesn't 422 the first attempt.
    // Server will log the reason + findings snapshot to content.send_overrides.
    const blockFindings = (preSendFindings || []).filter((f) => f.severity === "block");
    let overrideReason: string | undefined = undefined;
    if (blockFindings.length > 0) {
      const titles = blockFindings.map((f) => `  • [${f.gate}] ${f.title}`).join("\n");
      const reason = window.prompt(
        `${blockFindings.length} block-severity finding${blockFindings.length === 1 ? "" : "s"} outstanding:\n\n${titles}\n\nType a reason (≥ 10 chars) to override and send anyway. Blank cancels.`
      );
      if (!reason || reason.trim().length < 10) {
        setSending(false);
        return;
      }
      overrideReason = reason.trim();
    }

    const result = await opsPost<{ requestId: string; signers: Array<{ email: string; signingUrl: string }> }>(
      `/api/contracts/${selected.id}/send`,
      { signers: allSigners, signingMode: "sequential", override_reason: overrideReason }
    );
    if (result.ok && result.data?.signers) {
      setSendResult({ signingUrls: result.data.signers.map(s => s.signingUrl) });
      load();
    } else if (!result.ok && result.error) {
      // 422 from server with block findings we didn't anticipate (e.g. pre-send
      // was stale or didn't run). Surface the error verbatim — the operator
      // can close the form, re-open it to re-trigger the scan, and retry.
      window.alert(`Send blocked: ${result.error}`);
    }
    setSending(false);
  }

  async function handleRevoke() {
    if (!selected?.request_id) return;
    await opsPost(`/api/signatures/${selected.request_id}/revoke`, { reason: "Revoked from contracts page" });
    load();
  }

  async function handleDelete() {
    if (!selected) return;
    const ok = window.confirm(
      `Delete contract "${selected.title}"?\n\n` +
      `This removes the draft, version history, attachments, gate logs, and any ` +
      `cancelled/declined/expired signature requests. Sent contracts with active or ` +
      `completed signing must be revoked first.\n\n` +
      `This cannot be undone.`
    );
    if (!ok) return;
    const result = await opsDelete<{ ok: boolean }>(`/api/contracts/${selected.id}`);
    if (!result.ok) {
      window.alert(`Delete failed: ${result.error}`);
      return;
    }
    setSelected(null);
    load();
  }

  async function handleCreate() {
    if (!newTitle.trim()) return;
    setCreating(true);
    const result = await opsPost<{ ok: boolean; draft_id: string }>("/api/contracts/new", {
      title: newTitle.trim(),
      counterparty_id: newCounterpartyId || undefined,
      template: newTemplate,
      ...(newOnBehalfOfOrgId ? { on_behalf_of_org_id: newOnBehalfOfOrgId } : {}),
    });
    if (result.ok) {
      setShowNewForm(false);
      setNewTitle("");
      setNewCounterpartyId(null);
      setNewTemplate("service-proposal");
      const list = await load();
      const created = list.find((c) => c.id === result.data.draft_id);
      if (created) setSelected(created);
    }
    setCreating(false);
  }

  async function handleIngestFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      setIngestError("Please select a .docx file");
      return;
    }
    setIngestError(null);
    setIngesting(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
      }
      const b64 = btoa(binary);
      const result = await opsPost<{ ok: boolean; draft_id: string; brand_profile_id: string | null }>(
        "/api/contracts/ingest-proposal",
        { filename: file.name, content_base64: b64 }
      );
      if (!result.ok) { setIngestError(result.error); return; }
      setShowIngestForm(false);
      if (ingestInputRef.current) ingestInputRef.current.value = "";
      const list = await load();
      const created = list.find((c) => c.id === result.data.draft_id);
      if (created) setSelected(created);
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIngesting(false);
    }
  }

  // Pipeline step index for current contract
  function getStepIndex(status: string): number {
    const map: Record<string, number> = { draft: 0, review: 1, ready: 2, sent: 3, viewed: 4, signed: 5, completed: 5 };
    return map[status] ?? 0;
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">Loading contracts...</div>;
  }

  return (
    <div className="flex h-full">
      {/* Left: Contract List */}
      <div className="w-[360px] border-r border-zinc-800 flex flex-col shrink-0">
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold text-zinc-100">Contracts</h1>
            <div className="flex items-center gap-1">
              <a
                href="/contracts/branding"
                title="Brand profiles (fonts, color, logo)"
                className="px-2 py-1 text-[10px] font-medium rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              >
                Branding
              </a>
              <button
                onClick={() => setShowIngestForm(!showIngestForm)}
                title="Upload a proposal .docx — extract content + branding into a new contract"
                className="px-2.5 py-1 text-xs font-medium rounded-lg text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
              >
                Ingest
              </button>
              <button
                onClick={() => setShowNewForm(!showNewForm)}
                className="px-2.5 py-1 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 transition-colors"
              >
                + New
              </button>
            </div>
          </div>

          {/* Ingest proposal form */}
          {showIngestForm && (
            <div className="mb-3 p-3 rounded-lg border border-zinc-700 bg-zinc-900/50 space-y-2">
              <div className="text-xs text-zinc-400">
                Upload a finished proposal .docx. Content, logo, fonts, and brand color are extracted into a new contract.
              </div>
              <input
                ref={ingestInputRef}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleIngestFile}
                className="block w-full text-xs text-zinc-300 file:mr-3 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-amber-600 file:text-white hover:file:bg-amber-500 file:cursor-pointer"
              />
              {ingestError && (
                <div className="text-xs text-red-400">{ingestError}</div>
              )}
              {ingesting && (
                <div className="text-xs text-zinc-400">Ingesting… extracting branding + content</div>
              )}
              <button onClick={() => { setShowIngestForm(false); setIngestError(null); }} className="text-xs text-zinc-500 hover:text-zinc-400">
                Cancel
              </button>
            </div>
          )}

          {/* New contract form */}
          {showNewForm && (
            <div className="mb-3 p-3 rounded-lg border border-zinc-700 bg-zinc-900/50 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={newTemplate}
                  onChange={(e) => setNewTemplate(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none focus:border-amber-500/50"
                >
                  {templatesCatalog.length === 0 ? (
                    <>
                      <option value="service-proposal">Service Proposal</option>
                      <option value="nda">Non-Disclosure Agreement (NDA)</option>
                      <option value="sow">Statement of Work (SOW)</option>
                    </>
                  ) : (
                    templatesCatalog.map((t) => (
                      <option key={t.id} value={t.slug || t.id}>
                        {t.name}
                      </option>
                    ))
                  )}
                </select>
                <a
                  href="/contracts/templates"
                  title="Manage templates"
                  className="text-[10px] text-zinc-500 hover:text-amber-400 whitespace-nowrap"
                >
                  Manage →
                </a>
              </div>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Contract title (e.g. Service Proposal — Acme Corp)"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
                autoFocus
              />
              <CounterpartyPicker
                value={newCounterpartyId}
                onChange={(id) => setNewCounterpartyId(id)}
                placeholder="Client / counterparty (optional)"
                disabled={creating}
              />
              <OrgSelector
                value={newOnBehalfOfOrgId}
                onChange={setNewOnBehalfOfOrgId}
                disabled={creating}
                className="border-zinc-700 focus:border-amber-500/50"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={creating || !newTitle.trim()}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 transition-colors"
                >
                  {creating ? "Creating..." : "Create Contract"}
                </button>
                <button onClick={() => setShowNewForm(false)} className="text-xs text-zinc-500 hover:text-zinc-400">
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {([
              { key: "all", label: "All", count: contracts.length },
              { key: "draft", label: "Drafting", count: contracts.filter((c) => c.display_status === "draft" || c.display_status === "review").length },
              { key: "ready", label: "Ready", count: contracts.filter((c) => c.display_status === "ready").length },
              { key: "sent", label: "Signing", count: contracts.filter((c) => c.display_status === "sent" || c.display_status === "viewed").length },
              { key: "signed", label: "Completed", count: contracts.filter((c) => c.display_status === "signed" || c.display_status === "completed").length },
            ] as Array<{ key: FilterStage; label: string; count: number }>).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`px-2.5 py-1 text-[10px] font-medium rounded-lg transition-colors ${
                  filter === tab.key ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-400"
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-4 text-xs text-zinc-600 text-center">No contracts found</div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className={`w-full text-left px-4 py-3 border-b border-zinc-800/30 hover:bg-white/[0.02] transition-colors ${
                  selected?.id === c.id ? "bg-white/[0.06]" : ""
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${STATUS_COLORS[c.display_status] || STATUS_COLORS.draft}`}>
                    {c.display_status}
                  </span>
                  <span className="text-sm text-zinc-300 truncate flex-1">{c.title}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                  {c.client_name && <span>{c.client_name}</span>}
                  <span>{new Date(c.created_at).toLocaleDateString()}</span>
                  {c.total_signers > 0 && (
                    <span className={c.signed_count === c.total_signers ? "text-emerald-400" : "text-zinc-400"}>
                      {c.signed_count}/{c.total_signers} signed
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right: Detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-zinc-500">
              <svg className="w-12 h-12 mx-auto mb-3 text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm">Select a contract to review</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="p-4 border-b border-zinc-800">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">{selected.title}</h2>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                    {selected.client_name && (
                      selected.counterparty_id ? (
                        <a
                          href={`/counterparties/${selected.counterparty_id}`}
                          className="text-amber-400 hover:text-amber-300 hover:underline underline-offset-2"
                          title="View counterparty detail"
                        >
                          {selected.client_name}
                        </a>
                      ) : (
                        <span>{selected.client_name}</span>
                      )
                    )}
                    <span>{selected.word_count} words</span>
                    <span>${parseFloat(selected.cost_usd || "0").toFixed(4)}</span>
                  </div>
                </div>
                <div className="flex gap-2 relative">
                  <button
                    onClick={() => setShowVersions((v) => !v)}
                    title="Version history"
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1 ${
                      showVersions ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                    }`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    History
                  </button>
                  {selected.request_id && (
                    <a
                      href={`/verify/${selected.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Verify the signature hash chain"
                      className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors inline-flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                      Verify
                    </a>
                  )}
                  <a
                    href={`/api/ops?path=${encodeURIComponent(`/api/contracts/${selected.id}/pdf`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download contract + audit trail as PDF"
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors inline-flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
                    </svg>
                    PDF
                  </a>
                  <a
                    href={`/api/ops?path=${encodeURIComponent(`/api/contracts/${selected.id}/docx`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download contract + audit trail as Word .docx"
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors inline-flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
                    </svg>
                    DOCX
                  </a>
                  {(selected.display_status === "draft" || selected.display_status === "review") && (
                    <button
                      onClick={handleApprove}
                      title={usedBrackets.length > 0 ? `${usedBrackets.length} unfilled placeholder${usedBrackets.length === 1 ? "" : "s"} — you'll be asked to confirm` : "Approve this contract for sending"}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 ${
                        usedBrackets.length > 0
                          ? "bg-amber-600/40 text-amber-100 hover:bg-amber-600/60 border border-amber-500/40"
                          : "bg-amber-600 text-white hover:bg-amber-500"
                      }`}
                    >
                      {usedBrackets.length > 0 && (
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        </svg>
                      )}
                      Approve{usedBrackets.length > 0 ? ` · ${usedBrackets.length} unfilled` : ""}
                    </button>
                  )}
                  {selected.display_status === "ready" && (
                    <button
                      onClick={() => {
                        const opening = !showSendForm;
                        setShowSendForm(opening);
                        // Fire the G2/G7 check when the form opens — findings
                        // render inside the form. No-op if it's already cached.
                        if (opening && preSendFindings === null && !preSendLoading) {
                          setPreSendLoading(true);
                          opsPost<{ findings: PreSendFinding[] }>(`/api/contracts/${selected.id}/pre-send-check`, {})
                            .then((r) => setPreSendFindings(r.ok ? (r.data.findings || []) : []))
                            .finally(() => setPreSendLoading(false));
                        }
                        // Suggested recipients — same lazy pattern. Loaded
                        // once per contract; cleared when the user picks a
                        // different one.
                        if (opening && suggestions === null && !suggestionsLoading) {
                          void loadSuggestions();
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 transition-colors"
                    >
                      Send for Signature
                    </button>
                  )}
                  {(selected.display_status === "sent" || selected.display_status === "viewed") && (
                    <button onClick={handleRevoke} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20 transition-colors">
                      Revoke
                    </button>
                  )}
                  <button
                    onClick={handleDelete}
                    title="Permanently delete this contract draft (and history, attachments, gate logs). Active/completed signing must be revoked first."
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:bg-red-500/20 hover:text-red-400 border border-zinc-700 hover:border-red-500/30 transition-colors"
                  >
                    Delete
                  </button>
                  <ContractVersions
                    contractId={selected.id}
                    open={showVersions}
                    onClose={() => setShowVersions(false)}
                    onReverted={(newBody) => {
                      editorRef.current?.replaceBody(newBody);
                      setVersionsRefreshKey((k) => k + 1);
                    }}
                    refreshKey={versionsRefreshKey}
                  />
                </div>
              </div>

              {/* Pipeline strip */}
              <div className="flex items-center gap-0 mt-3" role="list" aria-label="Contract pipeline">
                {PIPELINE_STEPS.map((step, i) => {
                  const currentIdx = getStepIndex(selected.display_status);
                  const isCompleted = i < currentIdx;
                  const isActive = i === currentIdx;
                  const isFailed = (selected.display_status === "declined" || selected.display_status === "expired") && i === currentIdx;

                  return (
                    <div key={step} className="flex items-center" role="listitem" aria-current={isActive ? "step" : undefined}>
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold ${
                        isFailed ? "bg-red-500/30 ring-2 ring-red-400 text-red-300" :
                        isCompleted ? "bg-emerald-500/30 ring-1 ring-emerald-500 text-emerald-300" :
                        isActive ? "ring-2 ring-amber-400 bg-amber-500/20 text-amber-300 animate-pulse" :
                        "bg-zinc-800 ring-1 ring-zinc-700 text-zinc-600"
                      }`}>
                        {isCompleted ? "✓" : ""}
                      </div>
                      <span className={`text-[9px] ml-1 ${isActive ? "text-zinc-300 font-medium" : isCompleted ? "text-zinc-500" : "text-zinc-700"}`}>
                        {step}
                      </span>
                      {i < PIPELINE_STEPS.length - 1 && (
                        <div className={`w-6 h-px mx-1 ${isCompleted ? "bg-emerald-500/50" : "bg-zinc-800"}`} />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Per-signer state strip — only rendered once a request exists.
                  In sequential mode the first pending signer after all completed
                  ones is "active" (pulsing); others further down are "waiting". */}
              {signers.length > 0 && (
                <div className="mt-3 flex items-center gap-2 flex-wrap" role="list" aria-label="Signers">
                  {(() => {
                    const activeIdx = signingMode === "sequential"
                      ? signers.findIndex((s) => s.status === "pending" || s.status === "viewed")
                      : -1;
                    return signers.map((s, i) => {
                      const completed = s.status === "signed";
                      const declined = s.status === "declined" || s.status === "expired";
                      const isActive = i === activeIdx;
                      const waiting = signingMode === "sequential" && activeIdx !== -1 && i > activeIdx;
                      const pillClass =
                        completed ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
                        declined  ? "bg-red-500/15 text-red-300 border-red-500/30" :
                        isActive  ? "bg-amber-500/15 text-amber-200 border-amber-500/40 animate-pulse" :
                        waiting   ? "bg-zinc-900/60 text-zinc-500 border-zinc-800" :
                        s.status === "viewed" ? "bg-sky-500/15 text-sky-300 border-sky-500/30" :
                                    "bg-zinc-800/60 text-zinc-400 border-zinc-700";
                      const label =
                        completed ? "signed" :
                        declined  ? s.status :
                        waiting   ? "waiting" :
                        isActive  ? (s.status === "viewed" ? "viewing" : "signing now") :
                                    s.status;
                      return (
                        <div
                          key={s.id}
                          role="listitem"
                          title={`${s.display_name} <${s.email}> — ${s.status}${s.completed_at ? ` · ${new Date(s.completed_at).toLocaleString()}` : ""}`}
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded-full border ${pillClass}`}
                        >
                          {signingMode === "sequential" && s.signing_order !== null && (
                            <span className="text-[9px] opacity-60">{s.signing_order}.</span>
                          )}
                          <span className="max-w-[140px] truncate">{s.display_name || s.email}</span>
                          <span className="opacity-70">· {label}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>

            {/* Send for Signature form (inline slide-down) */}
            {showSendForm && (
              <div className="p-4 border-b border-zinc-800 bg-zinc-900/50 space-y-4">
                {/* G2 / G7 governance findings — non-blocking, informational */}
                {(preSendLoading || (preSendFindings && preSendFindings.length > 0)) && (
                  <div className={`rounded-lg border p-3 ${
                    preSendLoading ? "border-zinc-800 bg-zinc-900/80" :
                    preSendFindings?.some((f) => f.severity === "block") ? "border-red-500/40 bg-red-500/5" :
                    preSendFindings?.some((f) => f.severity === "warn") ? "border-amber-500/40 bg-amber-500/5" :
                    "border-sky-500/30 bg-sky-500/5"
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] font-semibold text-zinc-300 uppercase tracking-wider">
                        Pre-send review
                      </span>
                      {preSendLoading ? (
                        <span className="text-[10px] text-zinc-500">Scanning for commitment + precedent issues...</span>
                      ) : (
                        <span className="text-[10px] text-zinc-500">
                          {preSendFindings?.length || 0} finding{preSendFindings?.length === 1 ? "" : "s"} · non-blocking
                        </span>
                      )}
                    </div>
                    {preSendFindings && preSendFindings.length > 0 && (
                      <ul className="space-y-2">
                        {preSendFindings.map((f, i) => (
                          <li key={i} className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${
                                f.severity === "block" ? "bg-red-500/20 text-red-300" :
                                f.severity === "warn"  ? "bg-amber-500/20 text-amber-200" :
                                                         "bg-sky-500/20 text-sky-300"
                              }`}>
                                {f.severity}
                              </span>
                              <span className="px-1.5 py-0.5 text-[9px] font-mono rounded bg-zinc-800 text-zinc-400">
                                {f.gate}
                              </span>
                              <span className="text-[11px] text-zinc-200 font-medium">{f.title}</span>
                            </div>
                            {f.excerpt && (
                              <pre className="text-[10px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 mb-1 whitespace-pre-wrap break-words font-mono">{f.excerpt}</pre>
                            )}
                            {f.reason && (
                              <div className="text-[11px] text-zinc-400 leading-snug">{f.reason}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {/* Suggested recipients picker — four sections, checkbox-default.
                    Sections shown in this order: primary client signer (locked
                    by default), people extracted from the engagement's source
                    documents, signal contacts at the counterparty's domain,
                    UMB countersigners. Editing name/email inline is allowed.
                    The "+ Add" row at the bottom handles ad-hoc additions. */}
                {suggestionsLoading && (
                  <div className="text-[11px] text-zinc-500">Loading suggested recipients…</div>
                )}
                {!suggestionsLoading && editableSigners.length > 0 && (
                  <RecipientPicker
                    rows={editableSigners}
                    onChange={setEditableSigners}
                  />
                )}

                {/* Custom add row — fallback for anyone the discovery didn't find. */}
                <div className="flex gap-2 items-center pt-2 border-t border-zinc-800">
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Add recipient — name"
                    className="flex-1 px-3 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none focus:border-amber-500/50"
                  />
                  <input
                    value={customEmail}
                    onChange={(e) => setCustomEmail(e.target.value)}
                    placeholder="email@example.com"
                    type="email"
                    className="flex-1 px-3 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none focus:border-amber-500/50"
                  />
                  <button
                    onClick={() => {
                      const email = customEmail.trim().toLowerCase();
                      if (!email.includes("@")) return;
                      if (editableSigners.some((r) => r.email === email)) {
                        setCustomEmail("");
                        setCustomName("");
                        return;
                      }
                      setEditableSigners([
                        ...editableSigners,
                        {
                          name: customName.trim() || email.split("@")[0],
                          email,
                          source: "proposal",
                          note: "added manually",
                          default_selected: true,
                          selected: true,
                        },
                      ]);
                      setCustomEmail("");
                      setCustomName("");
                    }}
                    disabled={!customEmail.trim().includes("@")}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    + Add
                  </button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSend}
                    disabled={
                      sending ||
                      (editableSigners.filter((r) => r.selected && r.email.includes("@")).length === 0 &&
                        externalSigners.every((s) => !s.email.trim()) &&
                        internalSigners.size === 0)
                    }
                    className="px-4 py-2 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 transition-colors"
                  >
                    {sending ? "Sending..." : "Send for Signature"}
                  </button>
                  <button onClick={() => setShowSendForm(false)} className="text-xs text-zinc-500 hover:text-zinc-400">
                    Cancel
                  </button>
                </div>

                {/* Result */}
                {sendResult && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <p className="text-xs text-emerald-300 mb-1">Signing links sent! Client signers will receive an email.</p>
                    <p className="text-[10px] text-zinc-500">UMB signers will be notified when it&apos;s time to countersign.</p>
                  </div>
                )}
              </div>
            )}

            {/* Spawned work items — only for signed / completed contracts */}
            {(selected.display_status === "signed" || selected.display_status === "completed") && (
              <ContractWorkItems contractId={selected.id} />
            )}

            {/* Signer proposals — self-hides when none exist */}
            <ContractProposals
              contractId={selected.id}
              refreshKey={proposalsRefreshKey}
              onResolved={(wasAccept, revokedRequest) => {
                // Accept-with-redline mutates body + revokes request. Reload
                // contract list (status flipped to review), re-fetch the draft
                // body so the editor reflects the applied change, and bump
                // version history.
                if (wasAccept) {
                  load();
                  setVersionsRefreshKey((k) => k + 1);
                  if (revokedRequest) {
                    opsFetch<{ draft: { body: string } }>(`/api/content/drafts/${selected.id}`).then((d) => {
                      setDraftBody(d?.draft?.body || "");
                    });
                  }
                }
              }}
            />

            {/* Document editor + variable panel */}
            <div className="flex-1 overflow-hidden flex">
              <div className="flex-1 overflow-hidden flex flex-col">
                {draftBody ? (
                  <>
                    <div className="flex-1 overflow-hidden">
                      <ContractEditor
                        key={selected.id}
                        ref={editorRef}
                        draftId={selected.id}
                        content={draftBody}
                        readOnly={["sent", "signed", "completed", "published"].includes(selected.display_status)}
                        onUsedBracketsChange={setUsedBrackets}
                        onSaveStatusChange={(s) => {
                          // Auto-rescan governance findings 4s after the
                          // editor confirms the save landed in the DB. Skips
                          // rapid keystroke churn so we don't burn LLM budget.
                          if (s === "saved") scheduleRiskScan(4000);
                        }}
                      />
                    </div>
                    <ContractAttachments
                      contractId={selected.id}
                      readOnly={["sent", "signed", "completed", "published"].includes(selected.display_status)}
                    />
                    {!["sent", "signed", "completed", "published"].includes(selected.display_status) && (
                      <ContractAIBar
                        contractId={selected.id}
                        onApplyEdit={(newBody) => editorRef.current?.replaceBody(newBody)}
                        onUndo={() => editorRef.current?.undo()}
                        onVersionChanged={() => setVersionsRefreshKey((k) => k + 1)}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">Loading document...</div>
                )}
              </div>
              <aside className="w-[240px] shrink-0 border-l border-zinc-800 bg-zinc-950/50 flex flex-col overflow-y-auto">
                <div className="p-3">
                  <ContractRiskMeter
                    findings={preSendFindings}
                    scanning={preSendLoading}
                    lastScannedAt={lastRiskScanAt}
                    editable={!["sent", "signed", "completed", "published", "rejected"].includes(selected.display_status)}
                    onRescan={() => { void runRiskScan(); }}
                  />
                </div>
                <VariablePanel
                  usedBrackets={usedBrackets}
                  availableVars={availableVars}
                  onJump={(name) => editorRef.current?.jumpToBracket(name)}
                  onInsert={(name) => editorRef.current?.insertBracket(name)}
                />
              </aside>
            </div>

            {/* Audit trail */}
            {audit.length > 0 && (
              <details className="border-t border-zinc-800">
                <summary className="px-4 py-2 text-[10px] font-medium text-zinc-500 cursor-pointer hover:text-zinc-400">
                  Audit Trail ({audit.length} events)
                </summary>
                <div className="px-4 pb-3 space-y-2 max-h-48 overflow-y-auto">
                  {audit.map((e) => (
                    <div key={e.id} className="flex items-start gap-3 text-[10px]">
                      <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 bg-zinc-600" />
                      <div>
                        <span className={`font-medium ${
                          e.event_type === "signed" ? "text-emerald-400" :
                          e.event_type === "declined" ? "text-red-400" :
                          e.event_type === "viewed" ? "text-sky-400" :
                          "text-zinc-400"
                        }`}>
                          {e.event_type}
                        </span>
                        <span className="text-zinc-500"> — {e.signer_name} ({e.signer_email})</span>
                        {e.typed_name && <span className="text-zinc-400"> as &quot;{e.typed_name}&quot;</span>}
                        <div className="text-zinc-600">
                          {new Date(e.created_at).toLocaleString()}
                          {e.ip_address && ` · ${e.ip_address}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
