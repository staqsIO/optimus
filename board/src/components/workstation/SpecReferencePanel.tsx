"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { markdownToHtml } from "@/lib/markdown";
import { groupByDomain, DOMAIN_COLORS, STATUS_CONFIG, computeEffectiveStatus, domainStatusSummary, getDomainInfo } from "@/lib/spec-taxonomy";
import { computeLineDiff } from "@/lib/diff";
import { useSpecKeyboard, KEYBOARD_SHORTCUTS } from "./useSpecKeyboard";
import type {
  AgendaSection,
  SpecIndex,
  SpecContextEntry,
  SpecProjection,
  ProjectionStatus,
  SpecSection,
  SpecDomainGroup,
  SpecStatus,
  SpecProposal,
  ProposalAction,
  DiffLine,
} from "./types";

// --- Spec Graph Types ---

interface SpecGraphCrossRef {
  id: string;
  heading: string;
  domain?: string;
  context?: string;
}

interface SpecGraphCrossRefs {
  sectionId: string;
  outgoing: SpecGraphCrossRef[];
  incoming: SpecGraphCrossRef[];
}

interface SpecGraphImpact {
  sectionId: string;
  referencesOut: SpecGraphCrossRef[];
  referencesIn: SpecGraphCrossRef[];
  agents: { id: string; tier: string }[];
  gates: { id: string; name: string }[];
  principles: { id: string; name: string }[];
  tables: { name: string; schema: string }[];
}

interface SpecImplStatus {
  id: string;
  heading: string;
  domain: string;
  status: string;
  phase: number;
  agentCount: number;
  gateCount: number;
  tableCount: number;
  principleCount: number;
  totalArtifacts: number;
}

// --- Constants ---

const SPEC_MIN_WIDTH = 280;
const SPEC_MAX_WIDTH = 800;
const SPEC_DEFAULT_WIDTH = 420;
const SPEC_NARROW_WIDTH = 380;

// --- Projection Overlay (moved from AgendaPanel) ---

function ProjectionOverlay({
  projection,
  status,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onUpdateEdit,
  onRequestRevision,
}: {
  projection: SpecProjection;
  status: ProjectionStatus;
  onEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onUpdateEdit: (content: string) => void;
  onRequestRevision?: (feedback: string) => void;
}) {
  const [editText, setEditText] = useState(projection.editedContent);
  const [showRevisionFeedback, setShowRevisionFeedback] = useState(false);
  const [revisionFeedback, setRevisionFeedback] = useState("");

  useEffect(() => {
    setEditText(projection.editedContent);
  }, [projection.editedContent]);

  if (status === "loading") {
    return (
      <div className="mt-3 rounded-md border border-amber-500/20 overflow-hidden">
        <div className="h-1 bg-surface-overlay overflow-hidden">
          <div className="h-full w-1/3 bg-amber-400/60 rounded-full" style={{ animation: "shimmer 1.5s ease-in-out infinite" }} />
        </div>
        <div className="p-3 bg-amber-500/[0.04] space-y-2">
          <div className="flex items-center gap-2 text-xs text-amber-300 font-medium">
            <span className="w-4 h-4 border-2 border-amber-500/30 border-t-amber-400 rounded-full animate-spin" />
            Projecting edits to this section...
          </div>
          <p className="text-[10px] text-zinc-600 pl-6">Claude is analyzing the proposal and generating spec changes</p>
          <div className="space-y-1 pl-6">
            <div className="h-2.5 w-full bg-amber-500/10 rounded animate-pulse" />
            <div className="h-2.5 w-4/5 bg-amber-500/10 rounded animate-pulse" />
            <div className="h-2.5 w-3/5 bg-amber-500/10 rounded animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (status === "submitting") {
    return (
      <div className="mt-3 p-3 rounded-md bg-surface border border-white/5">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-3 h-3 border-2 border-zinc-600 border-t-green-500 rounded-full animate-spin" />
          Submitting...
        </div>
      </div>
    );
  }

  if (status === "editing") {
    return (
      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">Edit projected content:</span>
          <div className="flex gap-2">
            <button
              onClick={() => { onUpdateEdit(editText); onSaveEdit(); }}
              className="px-2.5 py-1 text-xs bg-green-500/15 text-green-400 rounded hover:bg-green-500/25 transition-colors"
            >
              Save edits
            </button>
            <button
              onClick={onCancelEdit}
              className="px-2.5 py-1 text-xs bg-surface-overlay text-zinc-400 rounded hover:bg-surface-selected transition-colors border border-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={Math.max(6, editText.split("\n").length + 2)}
          className="w-full px-3 py-2 text-xs font-mono bg-surface border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-y leading-relaxed"
        />
      </div>
    );
  }

  // Ready state — show diff
  const hasChanges = projection.diff.some((d) => d.type !== "equal");

  if (!hasChanges) {
    return (
      <div className="mt-3 p-3 rounded-md bg-surface border border-white/5">
        <p className="text-xs text-zinc-500 italic">No changes projected for this section.</p>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          Projected from: <span className="text-zinc-400">{projection.sourceItemTitle}</span>
        </span>
        <div className="flex gap-2">
          {onRequestRevision && (
            <button
              onClick={() => setShowRevisionFeedback((v) => !v)}
              className="px-2.5 py-1 text-xs bg-amber-500/10 text-amber-400 rounded hover:bg-amber-500/20 transition-colors border border-amber-500/20"
            >
              Request Revision
            </button>
          )}
          <button
            onClick={onEdit}
            className="px-2.5 py-1 text-xs bg-surface-overlay text-zinc-300 rounded hover:bg-surface-selected transition-colors border border-white/10"
          >
            Edit
          </button>
        </div>
      </div>
      {showRevisionFeedback && onRequestRevision && (
        <div className="space-y-2">
          <textarea
            value={revisionFeedback}
            onChange={(e) => setRevisionFeedback(e.target.value)}
            rows={3}
            placeholder="What should change? Be specific..."
            className="w-full px-3 py-2 text-xs bg-surface border border-amber-500/20 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/40 resize-y"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (revisionFeedback.trim()) {
                  onRequestRevision(revisionFeedback.trim());
                  setRevisionFeedback("");
                  setShowRevisionFeedback(false);
                }
              }}
              disabled={!revisionFeedback.trim()}
              className="px-2.5 py-1 text-xs bg-amber-500/15 text-amber-400 rounded hover:bg-amber-500/25 transition-colors border border-amber-500/20 disabled:opacity-40"
            >
              Revise
            </button>
            <button
              onClick={() => { setShowRevisionFeedback(false); setRevisionFeedback(""); }}
              className="px-2.5 py-1 text-xs bg-surface-overlay text-zinc-400 rounded hover:bg-surface-selected transition-colors border border-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="rounded-md bg-surface border border-white/5 overflow-hidden">
        <div className="overflow-x-auto">
          {projection.diff.map((line, i) => (
            <div
              key={i}
              className={`flex text-xs font-mono leading-5 ${
                line.type === "add"
                  ? "bg-green-500/10 text-green-400"
                  : line.type === "remove"
                  ? "bg-red-500/10 text-red-400"
                  : "text-zinc-500"
              }`}
            >
              <span className="w-5 flex-shrink-0 text-right pr-1 text-zinc-700 select-none">
                {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              </span>
              <span className="px-2 whitespace-pre-wrap break-all">{line.content}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Status Badge ---

function StatusBadge({ status, count }: { status: SpecStatus; count?: number }) {
  const config = STATUS_CONFIG[status];
  if (!config.badge) return null;

  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded ${config.badge}`}>
      {config.icon === "spinner" && (
        <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
      )}
      {config.icon === "check" && (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
        </svg>
      )}
      {config.icon === "count" && count != null && count}
      {config.icon === "avatar" && (
        <span className="w-2.5 h-2.5 rounded-full bg-current opacity-60" />
      )}
    </span>
  );
}

// --- Domain Group Header ---

function DomainGroupHeader({
  group,
  activityMap,
  collapsed,
  onToggle,
}: {
  group: SpecDomainGroup;
  activityMap: Map<string, { count: number; maxPriority: string; titles: string[] }>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const colors = DOMAIN_COLORS[group.domain.color] || DOMAIN_COLORS.zinc;
  const summary = domainStatusSummary(group.sections, activityMap);

  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-white/[0.02] border-b border-white/[0.04] ${colors.headerBg}`}
    >
      {/* Domain color dot */}
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colors.dot}`} />
      {/* Label */}
      <span className={`text-xs font-semibold uppercase tracking-wider ${colors.text}`}>
        {group.domain.label}
      </span>
      {/* Count + summary */}
      <span className="text-[10px] text-zinc-600 ml-auto">
        {group.sections.length} sections{summary ? ` · ${summary}` : ""}
      </span>
      {/* Collapse chevron */}
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`text-zinc-600 transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
      >
        <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
      </svg>
    </button>
  );
}

// --- Minimap ---

function DomainMinimap({
  domainGroups,
  activeSpecSectionIds,
  projectionSectionIds,
  loadingSectionIds,
  allSections,
  onScrollTo,
}: {
  domainGroups: SpecDomainGroup[];
  activeSpecSectionIds: string[];
  projectionSectionIds: string[];
  loadingSectionIds: string[];
  allSections: SpecSection[];
  onScrollTo: (sectionId: string) => void;
}) {
  const total = allSections.length;
  if (total === 0) return null;

  return (
    <div className="absolute inset-y-12 right-0 w-4 z-10 flex flex-col" aria-hidden="true">
      {domainGroups.map((group) => {
        const colors = DOMAIN_COLORS[group.domain.color] || DOMAIN_COLORS.zinc;
        const groupHeight = (group.sections.length / total) * 100;

        return (
          <div
            key={group.domain.id}
            className="relative"
            style={{ height: `${groupHeight}%`, minHeight: "8px" }}
          >
            {/* Domain color band */}
            <div className={`absolute inset-y-0 right-0 w-1 rounded-full opacity-30 ${colors.dot}`} />

            {/* Status dots for sections */}
            {group.sections.map((s, i) => {
              const hasProjection = projectionSectionIds.includes(s.id);
              const isLoading = loadingSectionIds.includes(s.id);
              const isActive = activeSpecSectionIds.includes(s.id);

              if (!hasProjection && !isActive) return null;

              const pct = (i / group.sections.length) * 100;
              return (
                <button
                  key={s.id}
                  onClick={() => onScrollTo(s.id)}
                  title={`\u00A7${s.id} ${s.heading}`}
                  className="absolute right-1.5 w-2 h-2 rounded-full cursor-pointer transition-colors hover:scale-150"
                  style={{ top: `${pct}%` }}
                >
                  <div className={`w-full h-full rounded-full ${
                    isLoading ? "bg-amber-400/60 animate-pulse"
                      : hasProjection ? "bg-green-400/60"
                      : "bg-indigo-400/40"
                  }`} />
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// --- Proposal Overlay ---

function ProposalOverlay({
  proposal,
  sectionId,
  currentContent,
  onAction,
  actionLoading,
}: {
  proposal: SpecProposal;
  sectionId: string;
  currentContent: string;
  onAction: (proposalId: string, action: ProposalAction, feedback?: string) => void;
  actionLoading?: boolean;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  // Find the section-specific proposal content
  const sectionProposal = proposal.sections.find((s) => s.sectionId === sectionId);
  if (!sectionProposal) return null;

  const diff = computeLineDiff(currentContent, sectionProposal.proposedContent);
  const hasChanges = diff.some((d) => d.type !== "equal");

  return (
    <div className="mt-3 rounded-md border border-green-500/20 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 bg-green-500/[0.06] border-b border-green-500/10 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-green-500/15 text-green-400 font-medium">
              PROPOSAL
            </span>
            <span className="text-xs text-zinc-400 truncate">{proposal.title}</span>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">
            from <span className="text-zinc-500">{proposal.agent_name || proposal.agent_tier}</span>
          </p>
        </div>
      </div>

      {/* Reasoning */}
      {sectionProposal.reasoning && (
        <div className="px-3 py-2 bg-green-500/[0.02] border-b border-green-500/10">
          <p className="text-[10px] text-zinc-500 leading-relaxed">{sectionProposal.reasoning}</p>
        </div>
      )}

      {/* Diff */}
      {hasChanges ? (
        <div className="overflow-x-auto">
          {diff.map((line, i) => (
            <div
              key={i}
              className={`flex text-xs font-mono leading-5 ${
                line.type === "add"
                  ? "bg-green-500/10 text-green-400"
                  : line.type === "remove"
                  ? "bg-red-500/10 text-red-400"
                  : "text-zinc-500"
              }`}
            >
              <span className="w-5 flex-shrink-0 text-right pr-1 text-zinc-700 select-none">
                {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              </span>
              <span className="px-2 whitespace-pre-wrap break-all">{line.content}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2">
          <p className="text-xs text-zinc-500 italic">No content changes for this section.</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="px-3 py-2 bg-surface border-t border-green-500/10 space-y-2">
        {showFeedback && (
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="Feedback for the agent (what should change?)..."
            className="w-full px-3 py-2 text-xs bg-surface-raised border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50 resize-y"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onAction(proposal.id, "approved")}
            disabled={actionLoading}
            className="px-2.5 py-1 text-xs bg-green-500/15 text-green-400 rounded hover:bg-green-500/25 transition-colors border border-green-500/20 disabled:opacity-40"
          >
            Approve
          </button>
          <button
            onClick={() => {
              if (showFeedback) {
                onAction(proposal.id, "revision-requested", feedback);
              } else {
                setShowFeedback(true);
              }
            }}
            disabled={actionLoading}
            className="px-2.5 py-1 text-xs bg-amber-500/15 text-amber-400 rounded hover:bg-amber-500/25 transition-colors border border-amber-500/20 disabled:opacity-40"
          >
            {showFeedback ? "Send revision request" : "Request Revision"}
          </button>
          <button
            onClick={() => onAction(proposal.id, "rejected", feedback || undefined)}
            disabled={actionLoading}
            className="px-2.5 py-1 text-xs bg-red-500/10 text-red-400 rounded hover:bg-red-500/20 transition-colors border border-red-500/20 disabled:opacity-40"
          >
            Reject
          </button>
          {showFeedback && (
            <button
              onClick={() => { setShowFeedback(false); setFeedback(""); }}
              className="px-2.5 py-1 text-xs bg-surface-overlay text-zinc-400 rounded hover:bg-surface-selected transition-colors border border-white/10"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Search Bar ---

function SearchBar({
  value,
  onChange,
  filter,
  onFilterChange,
  hasProposals,
  hasActive,
}: {
  value: string;
  onChange: (v: string) => void;
  filter: "all" | "active" | "has-proposals";
  onFilterChange: (f: "all" | "active" | "has-proposals") => void;
  hasProposals: boolean;
  hasActive: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search sections... (/)"
          className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
        />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      <div className="flex gap-1.5">
        {(["all", "active", "has-proposals"] as const).map((f) => {
          if (f === "has-proposals" && !hasProposals) return null;
          if (f === "active" && !hasActive) return null;
          const isActive = filter === f;
          return (
            <button
              key={f}
              onClick={() => onFilterChange(f)}
              className={`px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                isActive
                  ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/25"
                  : "bg-surface text-zinc-500 hover:text-zinc-400"
              }`}
            >
              {f === "all" ? "All" : f === "active" ? "Active" : "Has proposals"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Keyboard Help Overlay ---

function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-20 bg-black/60 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div className="bg-surface-raised border border-white/10 rounded-lg shadow-xl p-5 max-w-xs w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-zinc-200">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="space-y-2">
          {KEYBOARD_SHORTCUTS.map((s) => (
            <div key={s.key} className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">{s.description}</span>
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-surface border border-white/10 rounded text-zinc-300">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Implementation Status Badge ---

function ImplStatusBadge({ status }: { status: SpecImplStatus | undefined }) {
  if (!status) return null;
  const count = typeof status.totalArtifacts === 'object'
    ? (status.totalArtifacts as { low: number }).low || 0
    : Number(status.totalArtifacts) || 0;
  if (count === 0) return null;

  const color = count >= 3
    ? "bg-green-500/15 text-green-400 border-green-500/20"
    : count >= 1
    ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
    : "bg-zinc-500/15 text-zinc-500 border-zinc-500/20";

  const parts: string[] = [];
  const ac = typeof status.agentCount === 'object' ? (status.agentCount as { low: number }).low : Number(status.agentCount);
  const gc = typeof status.gateCount === 'object' ? (status.gateCount as { low: number }).low : Number(status.gateCount);
  const tc = typeof status.tableCount === 'object' ? (status.tableCount as { low: number }).low : Number(status.tableCount);
  if (ac > 0) parts.push(`${ac} agent${ac > 1 ? "s" : ""}`);
  if (gc > 0) parts.push(`${gc} gate${gc > 1 ? "s" : ""}`);
  if (tc > 0) parts.push(`${tc} table${tc > 1 ? "s" : ""}`);

  return (
    <span
      className={`ml-1 px-1 py-0.5 text-[9px] rounded border ${color}`}
      title={parts.join(", ") || "No linked artifacts"}
    >
      {count}
    </span>
  );
}

// --- Cross-Reference Sidebar ---

function CrossRefSidebar({
  impact,
  crossRefs,
  loading,
  onNavigate,
  onClose,
}: {
  impact: SpecGraphImpact | null;
  crossRefs: SpecGraphCrossRefs | null;
  loading: boolean;
  onNavigate: (sectionId: string) => void;
  onClose: () => void;
}) {
  if (loading) {
    return (
      <div className="border-t border-white/5 px-4 py-3 bg-surface space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Spec Graph</span>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-2/3 bg-zinc-800 rounded animate-pulse" />
          <div className="h-3 w-1/2 bg-zinc-800 rounded animate-pulse" />
          <div className="h-3 w-3/4 bg-zinc-800 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (!crossRefs && !impact) return null;

  const refs = crossRefs;
  const hasRefs = (refs?.outgoing?.length || 0) + (refs?.incoming?.length || 0) > 0;
  const hasImpact = (impact?.agents?.length || 0) + (impact?.gates?.length || 0) + (impact?.tables?.length || 0) > 0;

  if (!hasRefs && !hasImpact) return null;

  return (
    <div className="border-t border-white/5 px-4 py-3 bg-surface space-y-3 max-h-64 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
          Spec Graph — {"\u00A7"}{refs?.sectionId || impact?.sectionId}
        </span>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Cross-references */}
      {refs && refs.outgoing.length > 0 && (
        <div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">References</span>
          <div className="mt-1 space-y-0.5">
            {refs.outgoing.map((r) => (
              <button
                key={r.id}
                onClick={() => onNavigate(r.id)}
                className="block w-full text-left px-2 py-1 text-xs text-indigo-400 hover:bg-indigo-500/10 rounded transition-colors"
              >
                {"\u00A7"}{r.id} {r.heading}
              </button>
            ))}
          </div>
        </div>
      )}

      {refs && refs.incoming.length > 0 && (
        <div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Referenced by</span>
          <div className="mt-1 space-y-0.5">
            {refs.incoming.map((r) => (
              <button
                key={r.id}
                onClick={() => onNavigate(r.id)}
                className="block w-full text-left px-2 py-1 text-xs text-teal-400 hover:bg-teal-500/10 rounded transition-colors"
              >
                {"\u00A7"}{r.id} {r.heading}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Impact: linked agents, gates, tables */}
      {impact && impact.agents.length > 0 && (
        <div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Agents</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {impact.agents.map((a) => (
              <span key={a.id} className="px-1.5 py-0.5 text-[10px] bg-blue-500/15 text-blue-400 rounded border border-blue-500/20">
                {a.id}
              </span>
            ))}
          </div>
        </div>
      )}

      {impact && impact.gates.length > 0 && (
        <div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Gates</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {impact.gates.map((g) => (
              <span key={g.id} className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 rounded border border-amber-500/20">
                {g.id} {g.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {impact && impact.principles.length > 0 && (
        <div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Principles</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {impact.principles.map((p) => (
              <span key={p.id} className="px-1.5 py-0.5 text-[10px] bg-purple-500/15 text-purple-400 rounded border border-purple-500/20">
                {p.id} {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {impact && impact.tables.length > 0 && (
        <div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Tables</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {impact.tables.map((t) => (
              <span key={t.name} className="px-1.5 py-0.5 text-[10px] bg-teal-500/15 text-teal-400 rounded border border-teal-500/20 font-mono">
                {t.schema}.{t.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main Panel ---

export function SpecReferencePanel({
  specIndex,
  sections,
  activeSpecSectionIds,
  activeContext,
  narrow,
  projections,
  projectionStatus,
  projectionCommitMessage,
  projectionSourceItemId,
  onRequestProjection,
  onUpdateProjectionEdit,
  onSetProjectionStatus,
  onSubmitProjections,
  onSetProjectionCommitMessage,
  onClearProjections,
  proposals,
  onProposalAction,
  proposalActionLoading,
  onReviseProjection,
}: {
  specIndex: SpecIndex;
  sections: AgendaSection[];
  activeSpecSectionIds: string[];
  activeContext?: Record<string, SpecContextEntry[]>;
  narrow?: boolean;
  projections?: Record<string, SpecProjection>;
  projectionStatus?: Record<string, ProjectionStatus>;
  projectionCommitMessage?: string;
  projectionSourceItemId?: string | null;
  onRequestProjection?: (sectionId: string) => void;
  onUpdateProjectionEdit?: (sectionId: string, content: string) => void;
  onSetProjectionStatus?: (sectionId: string, status: ProjectionStatus) => void;
  onSubmitProjections?: (excludedSections?: Set<string>) => void;
  onSetProjectionCommitMessage?: (msg: string) => void;
  onClearProjections?: () => void;
  proposals?: SpecProposal[];
  onProposalAction?: (proposalId: string, action: ProposalAction, feedback?: string) => void;
  proposalActionLoading?: boolean;
  onReviseProjection?: (sectionId: string, feedback: string) => void;
}) {
  const sectionElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [width, setWidth] = useState(narrow ? SPEC_NARROW_WIDTH : SPEC_DEFAULT_WIDTH);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "has-proposals">("all");
  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(new Set());
  const [excludedSections, setExcludedSections] = useState<Set<string>>(new Set());
  const [focusedSectionId, setFocusedSectionId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Spec graph state
  const [specGraphSectionId, setSpecGraphSectionId] = useState<string | null>(null);
  const [specGraphCrossRefs, setSpecGraphCrossRefs] = useState<SpecGraphCrossRefs | null>(null);
  const [specGraphImpact, setSpecGraphImpact] = useState<SpecGraphImpact | null>(null);
  const [specGraphLoading, setSpecGraphLoading] = useState(false);
  const [implStatus, setImplStatus] = useState<Map<string, SpecImplStatus>>(new Map());
  const [reseedLoading, setReseedLoading] = useState(false);

  // Fetch implementation status on mount
  useEffect(() => {
    fetch("/api/workstation/spec-graph?action=status")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (Array.isArray(data)) {
          const map = new Map<string, SpecImplStatus>();
          for (const s of data) map.set(String(s.id), s);
          setImplStatus(map);
        }
      })
      .catch(() => {}); // graceful — no spec graph available
  }, []);

  // Fetch cross-refs + impact when a section is opened in spec graph
  useEffect(() => {
    if (!specGraphSectionId) return;
    setSpecGraphLoading(true);
    setSpecGraphCrossRefs(null);
    setSpecGraphImpact(null);

    Promise.all([
      fetch(`/api/workstation/spec-graph?action=cross-refs&section=${specGraphSectionId}`)
        .then((r) => r.ok ? r.json() : null),
      fetch(`/api/workstation/spec-graph?action=impact&section=${specGraphSectionId}`)
        .then((r) => r.ok ? r.json() : null),
    ])
      .then(([crossRefs, impact]) => {
        setSpecGraphCrossRefs(crossRefs);
        setSpecGraphImpact(impact);
      })
      .catch(() => {})
      .finally(() => setSpecGraphLoading(false));
  }, [specGraphSectionId]);

  const handleReseed = useCallback(async () => {
    setReseedLoading(true);
    try {
      const res = await fetch("/api/workstation/spec-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reseed" }),
      });
      if (res.ok) {
        // Refresh impl status after reseed
        const statusRes = await fetch("/api/workstation/spec-graph?action=status");
        if (statusRes.ok) {
          const data = await statusRes.json();
          if (Array.isArray(data)) {
            const map = new Map<string, SpecImplStatus>();
            for (const s of data) map.set(String(s.id), s);
            setImplStatus(map);
          }
        }
      }
    } catch {}
    setReseedLoading(false);
  }, []);

  // Sync default width when narrow prop changes
  useEffect(() => {
    setWidth((prev) => {
      if (prev === SPEC_DEFAULT_WIDTH || prev === SPEC_NARROW_WIDTH) {
        return narrow ? SPEC_NARROW_WIDTH : SPEC_DEFAULT_WIDTH;
      }
      return prev;
    });
  }, [narrow]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = width;

    const handleDragMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - moveEvent.clientX;
      const newWidth = Math.min(SPEC_MAX_WIDTH, Math.max(SPEC_MIN_WIDTH, dragStartWidth.current + delta));
      setWidth(newWidth);
    };

    const handleDragEnd = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  }, [width]);

  // Build activity map
  const activityMap = useMemo(() => {
    const map = new Map<string, { count: number; maxPriority: string; titles: string[] }>();
    for (const section of sections) {
      for (const item of section.items) {
        if (!item.specRefs) continue;
        for (const ref of item.specRefs) {
          const existing = map.get(ref.sectionId);
          if (existing) {
            existing.count++;
            if (!existing.titles.includes(item.title)) existing.titles.push(item.title);
            if (item.priority === "high" || (item.priority === "medium" && existing.maxPriority === "low")) {
              existing.maxPriority = item.priority;
            }
          } else {
            map.set(ref.sectionId, { count: 1, maxPriority: item.priority, titles: [item.title] });
          }
        }
      }
    }
    return map;
  }, [sections]);

  // Build proposals-by-section map
  const proposalsBySectionId = useMemo(() => {
    const map = new Map<string, SpecProposal[]>();
    if (!proposals) return map;
    for (const p of proposals) {
      for (const s of p.sections) {
        const existing = map.get(s.sectionId) || [];
        existing.push(p);
        map.set(s.sectionId, existing);
      }
    }
    return map;
  }, [proposals]);

  // Group sections by domain
  const domainGroups = useMemo(
    () => groupByDomain(specIndex.sections),
    [specIndex.sections]
  );

  // Projection state for minimap + keyboard nav (memoized to avoid ref churn)
  const projectionSectionIds = useMemo(
    () => projections
      ? Object.entries(projectionStatus || {}).filter(([, s]) => s !== "idle").map(([id]) => id)
      : [],
    [projections, projectionStatus]
  );
  const loadingSectionIds = useMemo(
    () => projections
      ? Object.entries(projectionStatus || {}).filter(([, s]) => s === "loading").map(([id]) => id)
      : [],
    [projections, projectionStatus]
  );

  // Compute flat visible section ID list for keyboard navigation
  const visibleSectionIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of domainGroups) {
      if (collapsedDomains.has(group.domain.id)) continue;
      for (const s of group.sections) {
        if (shouldShowSection(s)) ids.push(s.id);
      }
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainGroups, collapsedDomains, search, filter, activityMap, projectionSectionIds, proposalsBySectionId]);

  // Keyboard shortcuts
  const { showHelp, setShowHelp } = useSpecKeyboard({
    enabled: true,
    visibleSectionIds,
    focusedSectionId,
    projectionStatus: projectionStatus || {},
    onFocusSection: (id) => {
      setFocusedSectionId(id);
      const el = sectionElRefs.current.get(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    onEditProjection: (id) => onSetProjectionStatus?.(id, "editing"),
    onSubmitProjections: () => onSubmitProjections?.(excludedSections.size > 0 ? excludedSections : undefined),
    onFocusSearch: () => searchInputRef.current?.focus(),
  });

  // Scroll to section
  useEffect(() => {
    if (activeSpecSectionIds.length === 0) return;
    const el = sectionElRefs.current.get(activeSpecSectionIds[0]);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeSpecSectionIds]);

  const scrollToSection = useCallback((sectionId: string) => {
    const el = sectionElRefs.current.get(sectionId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const badgeColor: Record<string, string> = {
    high: "bg-red-500/15 text-red-400",
    medium: "bg-amber-500/15 text-amber-400",
    low: "bg-accent/15 text-accent",
  };

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Search + filter
  const searchLower = search.toLowerCase();
  const hasAnyActive = activityMap.size > 0;
  const hasAnyProposals = projectionSectionIds.length > 0 || proposalsBySectionId.size > 0;

  function toggleDomain(domainId: string) {
    setCollapsedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domainId)) next.delete(domainId);
      else next.add(domainId);
      return next;
    });
  }

  function shouldShowSection(s: SpecSection): boolean {
    if (search && !s.heading.toLowerCase().includes(searchLower) && !s.id.includes(search)) {
      return false;
    }
    if (filter === "active" && !activityMap.has(s.id)) return false;
    if (filter === "has-proposals" && !projectionSectionIds.includes(s.id) && !proposalsBySectionId.has(s.id)) return false;
    return true;
  }

  return (
    <aside
      style={{ width }}
      className="flex-shrink-0 bg-surface-raised flex flex-col overflow-hidden relative"
      aria-label="Spec reference"
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize z-10 border-l border-white/5 hover:border-indigo-500/50 hover:bg-indigo-500/10 active:bg-indigo-500/15 transition-colors"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize spec panel"
      />

      {/* Minimap */}
      {(projectionSectionIds.length > 0 || activeSpecSectionIds.length > 0) && (
        <DomainMinimap
          domainGroups={domainGroups}
          activeSpecSectionIds={activeSpecSectionIds}
          projectionSectionIds={projectionSectionIds}
          loadingSectionIds={loadingSectionIds}
          allSections={specIndex.sections}
          onScrollTo={scrollToSection}
        />
      )}

      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3 border-b border-white/5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            SPEC v{specIndex.version}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600">
              {specIndex.sections.length} sections · {domainGroups.length} domains
            </span>
            <button
              onClick={() => setShowHelp(true)}
              className="w-5 h-5 flex items-center justify-center text-[10px] font-mono text-zinc-600 hover:text-zinc-400 rounded border border-white/10 hover:border-white/20 transition-colors"
              title="Keyboard shortcuts (?)"
            >
              ?
            </button>
          </div>
        </div>
        <SearchBar
          value={search}
          onChange={setSearch}
          filter={filter}
          onFilterChange={setFilter}
          hasProposals={hasAnyProposals}
          hasActive={hasAnyActive}
        />
      </div>

      {/* Keyboard help overlay */}
      {showHelp && <KeyboardHelp onClose={() => setShowHelp(false)} />}

      {/* Scrollable spec content — grouped by domain */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {domainGroups.map((group) => {
          const isCollapsed = collapsedDomains.has(group.domain.id);
          const visibleSections = group.sections.filter(shouldShowSection);

          // If search is active and no sections match, hide the entire group
          if ((search || filter !== "all") && visibleSections.length === 0) return null;

          const colors = DOMAIN_COLORS[group.domain.color] || DOMAIN_COLORS.zinc;

          return (
            <div key={group.domain.id}>
              <DomainGroupHeader
                group={group}
                activityMap={activityMap}
                collapsed={isCollapsed}
                onToggle={() => toggleDomain(group.domain.id)}
              />

              {!isCollapsed && visibleSections.map((s) => {
                const activity = activityMap.get(s.id);
                const isActive = activeSpecSectionIds.includes(s.id);
                const isSubsection = s.level === 3;
                const hasProjection = projectionSectionIds.includes(s.id);
                const effectiveStatus = computeEffectiveStatus(s.status, activity?.count || 0, hasProjection);

                return (
                  <div
                    key={s.id}
                    ref={(el) => {
                      if (el) sectionElRefs.current.set(s.id, el);
                      else sectionElRefs.current.delete(s.id);
                    }}
                    className={`px-5 py-4 border-b border-white/[0.03] scroll-mt-0 transition-colors duration-200 ${
                      isSubsection ? "pl-8" : ""
                    } ${
                      isActive
                        ? `${colors.bg} border-l-2 ${colors.border}`
                        : `border-l-2 ${STATUS_CONFIG[effectiveStatus]?.border || "border-l-transparent"}`
                    } ${focusedSectionId === s.id ? "ring-1 ring-inset ring-accent/30" : ""}`}
                    onClick={() => setFocusedSectionId(s.id)}
                  >
                    {/* Section heading */}
                    <div className="flex items-center gap-2 mb-2">
                      {/* Checkbox for selective PR inclusion */}
                      {hasProjection && (
                        <input
                          type="checkbox"
                          checked={!excludedSections.has(s.id)}
                          onChange={() => {
                            setExcludedSections((prev) => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id);
                              else next.add(s.id);
                              return next;
                            });
                          }}
                          className="w-3 h-3 rounded border-white/20 bg-surface text-green-500 focus:ring-0 focus:ring-offset-0 flex-shrink-0"
                          title="Include in PR"
                        />
                      )}
                      <span className={`text-xs font-mono ${isActive ? colors.text : "text-zinc-600"}`}>
                        {"\u00A7"}{s.id}
                      </span>
                      <span className={`text-sm font-medium ${
                        isActive ? "text-zinc-200" : activity ? "text-zinc-300" : "text-zinc-500"
                      }`}>
                        {s.heading}
                      </span>
                      {/* Status badge */}
                      {effectiveStatus !== "stable" && (
                        <StatusBadge status={effectiveStatus} count={activity?.count} />
                      )}
                      {/* Implementation status badge */}
                      <ImplStatusBadge status={implStatus.get(s.id)} />
                      {/* Spec graph toggle */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSpecGraphSectionId((prev) => prev === s.id ? null : s.id);
                        }}
                        className={`ml-auto flex-shrink-0 w-5 h-5 flex items-center justify-center text-[10px] rounded transition-colors ${
                          specGraphSectionId === s.id
                            ? "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30"
                            : "text-zinc-600 hover:text-zinc-400 hover:bg-surface-overlay"
                        }`}
                        title="Show spec graph connections"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="4" cy="4" r="2" />
                          <circle cx="12" cy="4" r="2" />
                          <circle cx="8" cy="12" r="2" />
                          <line x1="6" y1="4" x2="10" y2="4" />
                          <line x1="4" y1="6" x2="8" y2="10" />
                          <line x1="12" y1="6" x2="8" y2="10" />
                        </svg>
                      </button>
                      {/* Activity count badge (when no status badge already shows it) */}
                      {activity && effectiveStatus === "stable" && (
                        <span className={`flex-shrink-0 px-1.5 py-0.5 text-xs rounded ${
                          badgeColor[activity.maxPriority] || badgeColor.low
                        }`}>
                          {activity.count}
                        </span>
                      )}
                    </div>

                    {/* Item annotations */}
                    {isActive && activeContext?.[s.id] && activeContext[s.id].length > 0 && (
                      <div className="mb-2 space-y-1">
                        {activeContext[s.id].map((entry) => (
                          <div key={entry.title} className="flex items-start gap-1.5 text-xs leading-relaxed">
                            <span className={`${colors.text} opacity-70 flex-shrink-0 mt-px`}>&rarr;</span>
                            <div className="min-w-0">
                              <span className={`${colors.text} opacity-80`}>{entry.title}</span>
                              <span className="block text-zinc-600 font-mono text-[10px] truncate" title={entry.file}>
                                {entry.file}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Section content */}
                    {!(projections?.[s.id] && projectionStatus?.[s.id] && projectionStatus[s.id] !== "idle") && (
                      <div
                        className={`prose prose-sm prose-invert max-w-none leading-relaxed transition-colors duration-200 ${
                          isActive ? "text-zinc-400" : "text-zinc-500"
                        }`}
                        dangerouslySetInnerHTML={{ __html: markdownToHtml(s.content) }}
                      />
                    )}

                    {/* Projection overlay */}
                    {projections?.[s.id] && projectionStatus?.[s.id] && projectionStatus[s.id] !== "idle" && (
                      <ProjectionOverlay
                        projection={projections[s.id]}
                        status={projectionStatus[s.id]}
                        onEdit={() => onSetProjectionStatus?.(s.id, "editing")}
                        onSaveEdit={() => onSetProjectionStatus?.(s.id, "ready")}
                        onCancelEdit={() => {
                          onUpdateProjectionEdit?.(s.id, projections[s.id].projectedContent);
                          onSetProjectionStatus?.(s.id, "ready");
                        }}
                        onUpdateEdit={(content) => onUpdateProjectionEdit?.(s.id, content)}
                        onRequestRevision={onReviseProjection ? (feedback) => onReviseProjection(s.id, feedback) : undefined}
                      />
                    )}

                    {/* Agent proposal overlays */}
                    {proposalsBySectionId.has(s.id) && onProposalAction && (
                      proposalsBySectionId.get(s.id)!.map((proposal) => (
                        <ProposalOverlay
                          key={proposal.id}
                          proposal={proposal}
                          sectionId={s.id}
                          currentContent={s.content}
                          onAction={onProposalAction}
                          actionLoading={proposalActionLoading}
                        />
                      ))
                    )}

                    {/* "Project" button */}
                    {isActive && projectionSourceItemId && !projections?.[s.id] && projectionStatus?.[s.id] !== "loading" && onRequestProjection && (
                      <button
                        onClick={() => onRequestProjection(s.id)}
                        className="mt-2 px-2.5 py-1 text-xs bg-indigo-500/10 text-indigo-400 rounded hover:bg-indigo-500/20 transition-colors border border-indigo-500/20"
                      >
                        Project changes
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Spec graph sidebar */}
      {specGraphSectionId && (
        <CrossRefSidebar
          impact={specGraphImpact}
          crossRefs={specGraphCrossRefs}
          loading={specGraphLoading}
          onNavigate={(id) => {
            setSpecGraphSectionId(id);
            const el = sectionElRefs.current.get(id);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          onClose={() => setSpecGraphSectionId(null)}
        />
      )}

      {/* Reseed button (bottom bar, always visible) */}
      <div className="flex-shrink-0 px-4 py-1.5 border-t border-white/5 bg-surface flex items-center justify-between">
        <span className="text-[10px] text-zinc-600">
          {implStatus.size > 0 ? `${implStatus.size} sections indexed` : "Spec graph"}
        </span>
        <button
          onClick={handleReseed}
          disabled={reseedLoading}
          className="px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-surface-overlay rounded transition-colors disabled:opacity-40"
          title="Re-seed spec graph from source files"
        >
          {reseedLoading ? "Reseeding..." : "Refresh"}
        </button>
      </div>

      {/* Submit bar */}
      {projections && projectionStatus && (() => {
        const allReady = Object.entries(projectionStatus).filter(
          ([, s]) => s === "ready" || s === "editing"
        );
        const includedCount = allReady.filter(([id]) => !excludedSections.has(id)).length;
        const readyCount = allReady.length;
        const anyLoading = Object.values(projectionStatus).some((s) => s === "loading");
        const anySubmitting = Object.values(projectionStatus).some((s) => s === "submitting");
        if (readyCount === 0 && !anyLoading && !anySubmitting) return null;

        // Find next unreviewed projection (not focused yet)
        const unreviewedId = allReady
          .map(([id]) => id)
          .find((id) => id !== focusedSectionId);

        return (
          <div className="flex-shrink-0 px-4 py-3 border-t border-white/5 bg-surface space-y-2">
            <input
              type="text"
              value={projectionCommitMessage || ""}
              onChange={(e) => onSetProjectionCommitMessage?.(e.target.value)}
              placeholder="Commit message..."
              className="w-full px-3 py-1.5 text-xs bg-surface-raised border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
            />
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  onClick={() => onSubmitProjections?.(excludedSections.size > 0 ? excludedSections : undefined)}
                  disabled={includedCount === 0 || anyLoading || anySubmitting}
                  className="px-3 py-1.5 text-xs bg-green-500/15 text-green-400 rounded hover:bg-green-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border border-green-500/20"
                  title={`Create PR with ${includedCount} section${includedCount === 1 ? "" : "s"} (\u2318+Enter)`}
                >
                  {anySubmitting ? "Creating PR..." : `Create PR (${includedCount})`}
                </button>
                {unreviewedId && (
                  <button
                    onClick={() => {
                      setFocusedSectionId(unreviewedId);
                      const el = sectionElRefs.current.get(unreviewedId);
                      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
                    }}
                    className="px-3 py-1.5 text-xs bg-indigo-500/10 text-indigo-400 rounded hover:bg-indigo-500/20 transition-colors border border-indigo-500/20"
                    title="Review next projection (n)"
                  >
                    Review next
                  </button>
                )}
                <button
                  onClick={onClearProjections}
                  disabled={anySubmitting}
                  className="px-3 py-1.5 text-xs bg-surface-overlay text-zinc-400 rounded hover:bg-surface-selected transition-colors border border-white/10 disabled:opacity-40"
                >
                  Discard all
                </button>
              </div>
              <span className="text-xs text-zinc-500 flex items-center gap-2">
                {readyCount > 0 && (
                  <span>
                    {includedCount}/{readyCount} section{readyCount === 1 ? "" : "s"}
                    {excludedSections.size > 0 && (
                      <button
                        onClick={() => setExcludedSections(new Set())}
                        className="ml-1 text-accent hover:underline"
                      >
                        include all
                      </button>
                    )}
                  </span>
                )}
                {anyLoading && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
                    <span className="w-2.5 h-2.5 border-2 border-amber-500/30 border-t-amber-400 rounded-full animate-spin" />
                    projecting...
                  </span>
                )}
              </span>
            </div>
          </div>
        );
      })()}
    </aside>
  );
}

export default SpecReferencePanel;
