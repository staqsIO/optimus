"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

// --- Types ---

interface SpecSection {
  id: string;
  title: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  tier: "core" | "operations" | "planning";
}

interface SpecModule {
  name: string;
  title: string;
  content: string;
  status: "draft";
}

// --- Cross-reference data ---

/** Known cross-references between spec sections, ADRs, issues, and files */
const CROSS_REFS: Record<string, { adrs?: string[]; issues?: string[]; files?: string[]; related?: string[]; agents?: string[] }> = {
  "0": { adrs: ["ADR-001"], related: ["13"], files: ["CONSTITUTION.md"] },
  "1": { related: ["0", "2"], files: ["spec/SPEC.md"] },
  "2": { adrs: ["ADR-009"], related: ["3", "4"], agents: ["orchestrator", "strategist", "architect"], files: ["config/agents.json"] },
  "3": { adrs: ["ADR-001", "ADR-010"], related: ["2", "5"], files: ["autobot-inbox/sql/001-baseline.sql", "autobot-inbox/src/runtime/state-machine.js"], agents: ["orchestrator"] },
  "4": { adrs: ["ADR-008"], related: ["6", "7"], files: ["autobot-inbox/src/adapters/"], agents: ["orchestrator"] },
  "5": { adrs: ["ADR-010", "ADR-017"], related: ["3", "13"], files: ["autobot-inbox/src/runtime/guard-check.js", "autobot-inbox/src/runtime/infrastructure.js"] },
  "6": { adrs: ["ADR-013"], related: ["4", "7"], files: ["autobot-inbox/src/agents/executor-responder.js", "autobot-inbox/src/voice/"] },
  "7": { adrs: ["ADR-014"], related: ["4", "8"], files: ["autobot-inbox/src/signal/"], agents: ["executor-intake", "orchestrator"] },
  "8": { related: ["6", "9"], files: ["autobot-inbox/src/agents/reviewer.js"], agents: ["reviewer"] },
  "9": { adrs: ["ADR-019"], related: ["3", "5"], files: ["autobot-inbox/src/graph/"] },
  "10": { related: ["1", "11"], files: ["autobot-inbox/src/cli/"] },
  "11": { related: ["10", "12"], files: ["dashboard/", "autobot-inbox/dashboard/"] },
  "12": { adrs: ["ADR-002"], related: ["5", "13"], files: ["autobot-inbox/sql/"] },
  "13": { related: ["0", "5"], files: ["CONSTITUTION.md", "autobot-inbox/src/runtime/guard-check.js"] },
  "14": { issues: ["#59"], related: ["15", "16"], files: ["autobot-inbox/src/runtime/phase1-metrics.js"] },
  "15": { related: ["14", "16"] },
  "16": { related: ["14", "15", "17"] },
  "17": { related: ["0", "13"], files: ["CONSTITUTION.md"] },
};

// --- Constants ---

// Section-to-tier mapping from SPEC-INDEX.md
const TIER_MAP: Record<string, "core" | "operations" | "planning"> = {
  "0": "core",
  "1": "core",
  "2": "core",
  "3": "core",
  "5": "core",
  "13": "core",
  "17": "core",
  "4": "operations",
  "5a": "operations",
  "6": "operations",
  "7": "operations",
  "8": "operations",
  "9": "operations",
  "10": "operations",
  "11": "operations",
  "12": "operations",
  "14": "planning",
  "15": "planning",
  "16": "planning",
  "18": "planning",
  "19": "planning",
  "20": "planning",
};

const TIER_LABELS: Record<string, { label: string; color: string }> = {
  core: { label: "Core", color: "text-red-400" },
  operations: { label: "Operations", color: "text-blue-400" },
  planning: { label: "Planning", color: "text-emerald-400" },
};

const PROPOSED_MODULES: SpecModule[] = [
  {
    name: "board-experience",
    title: "Board Experience",
    content:
      "How board members interact day-to-day. Morning routine, async notifications, weekly reviews.\n\nThis module is proposed but not yet written. Submit an amendment to contribute.",
    status: "draft",
  },
  {
    name: "channel-architecture",
    title: "Channel Architecture",
    content:
      "Email, Linear, Slack, Telegram, webhook intake patterns. What works, what doesn't.\n\nThis module is proposed but not yet written. Submit an amendment to contribute.",
    status: "draft",
  },
  {
    name: "autonomy-operating-model",
    title: "Autonomy Operating Model",
    content:
      "When to use L0 vs L1 vs L2. Current defaults. Promotion criteria that actually work.\n\nThis module is proposed but not yet written. Submit an amendment to contribute.",
    status: "draft",
  },
  {
    name: "multi-user-governance",
    title: "Multi-User Governance",
    content:
      "Individual identity on actions, domain delegation, shared activity feed.\n\nThis module is proposed but not yet written. Submit an amendment to contribute.",
    status: "draft",
  },
];

// --- Helpers ---

/** Extract a section number from a heading like "## §5a. Knowledge Graph Layer" */
function extractSectionId(heading: string): string {
  // Match §N or §Na patterns
  const match = heading.match(/§(\d+[a-z]?)/);
  if (match) return match[1];
  // Fallback: try "## N." or "## N " pattern
  const numMatch = heading.match(/^##\s+(\d+[a-z]?)[\.\s]/);
  if (numMatch) return numMatch[1];
  // Design Principles special case
  if (heading.includes("Design Principles")) return "0";
  return heading.replace(/^##\s+/, "").slice(0, 20).replace(/\s+/g, "-").toLowerCase();
}

/** Parse SPEC.md content into sections */
function parseSpecSections(content: string): SpecSection[] {
  const lines = content.split("\n");
  const sections: SpecSection[] = [];
  let currentHeading = "";
  let currentStart = 0;
  let currentContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match ## headings (but not ### or #)
    if (/^## /.test(line)) {
      // Save previous section
      if (currentHeading) {
        const id = extractSectionId(currentHeading);
        const title = currentHeading.replace(/^##\s+/, "");
        sections.push({
          id,
          title,
          content: currentContent.join("\n"),
          lineStart: currentStart + 1,
          lineEnd: i,
          tier: TIER_MAP[id] || "planning",
        });
      }
      currentHeading = line;
      currentStart = i;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Push last section
  if (currentHeading) {
    const id = extractSectionId(currentHeading);
    const title = currentHeading.replace(/^##\s+/, "");
    sections.push({
      id,
      title,
      content: currentContent.join("\n"),
      lineStart: currentStart + 1,
      lineEnd: lines.length,
      tier: TIER_MAP[id] || "planning",
    });
  }

  return sections;
}

// --- Components ---

function SectionNav({
  sections,
  modules,
  selectedId,
  onSelect,
  showModules,
  onToggleModules,
}: {
  sections: SpecSection[];
  modules: SpecModule[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showModules: boolean;
  onToggleModules: () => void;
}) {
  const grouped = useMemo(() => {
    const groups: Record<string, SpecSection[]> = {
      core: [],
      operations: [],
      planning: [],
    };
    for (const s of sections) {
      if (groups[s.tier]) groups[s.tier].push(s);
    }
    return groups;
  }, [sections]);

  return (
    <div className="space-y-4">
      {(["core", "operations", "planning"] as const).map((tier) => {
        const info = TIER_LABELS[tier];
        const items = grouped[tier];
        if (!items || items.length === 0) return null;
        return (
          <div key={tier}>
            <div
              className={`text-[10px] uppercase tracking-wider font-semibold mb-1.5 ${info.color}`}
            >
              {info.label}
            </div>
            <div className="space-y-0.5">
              {items.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors truncate ${
                    selectedId === s.id
                      ? "bg-accent/10 text-accent-bright"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
                  }`}
                  title={s.title}
                >
                  <span className="text-zinc-600 mr-1">§{s.id}</span>
                  {s.title.replace(/^§\d+[a-z]?\.\s*/, "")}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {/* Modules */}
      <div>
        <button
          onClick={onToggleModules}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold mb-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <span className="text-[8px]">{showModules ? "\u25BC" : "\u25B6"}</span>
          Modules (Draft)
        </button>
        {showModules && (
          <div className="space-y-0.5">
            {modules.map((m) => (
              <button
                key={m.name}
                onClick={() => onSelect(`module:${m.name}`)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors truncate ${
                  selectedId === `module:${m.name}`
                    ? "bg-accent/10 text-accent-bright"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span className="text-zinc-600 mr-1 italic">draft</span>
                {m.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AmendmentModal({
  section,
  onClose,
  onSubmitted,
}: {
  section: SpecSection | SpecModule;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [proposedChange, setProposedChange] = useState("");
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const title =
    "id" in section ? `§${section.id} ${section.title}` : section.title;

  async function handleSubmit() {
    if (!proposedChange.trim() || !rationale.trim()) {
      setError("Both fields are required.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/governance?path=/api/governance/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Spec Amendment: ${title}`,
          content_type: "spec_amendment",
          content: proposedChange.trim(),
          rationale: rationale.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Submit failed" }));
        setError(data.error || "Submit failed");
        return;
      }
      setSuccess(true);
      setTimeout(() => {
        onSubmitted();
        onClose();
      }, 1500);
    } catch {
      setError("Network error. Is the backend running?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h3 className="text-sm font-semibold text-zinc-100">
            Propose Amendment
          </h3>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Section label */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
              Section
            </label>
            <div className="text-sm text-zinc-300 bg-surface-raised rounded px-3 py-2 border border-white/5">
              {title}
            </div>
          </div>

          {/* Proposed change */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
              Proposed Change
            </label>
            <textarea
              value={proposedChange}
              onChange={(e) => setProposedChange(e.target.value)}
              rows={6}
              placeholder="Describe or paste the proposed spec change..."
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright resize-y"
            />
          </div>

          {/* Rationale */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
              Rationale
            </label>
            <input
              type="text"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why is this change needed?"
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          {success && (
            <p className="text-xs text-emerald-400">
              Amendment submitted to governance inbox.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || success}
            className="px-4 py-1.5 text-xs font-medium bg-accent-bright/20 text-accent-bright rounded hover:bg-accent-bright/30 transition-colors disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit Amendment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SpecContent({
  section,
  onPropose,
}: {
  section: SpecSection | SpecModule | null;
  onPropose: () => void;
}) {
  if (!section) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-zinc-200 mb-2">
            SPEC.md Browser
          </h2>
          <p className="text-sm text-zinc-500 max-w-md">
            Select a section from the sidebar to read the specification.
            Sections are grouped by mutability: Core (rigid, board review
            required), Operations (iterates with approval), and Planning
            (iterates fast).
          </p>
        </div>
      </div>
    );
  }

  const isModule = !("id" in section);
  const title = isModule ? section.title : `§${section.id}. ${section.title.replace(/^§\d+[a-z]?\.\s*/, "")}`;
  const tier = isModule
    ? null
    : TIER_LABELS[(section as SpecSection).tier];

  return (
    <div>
      {/* Section header */}
      <div className="flex items-start justify-between mb-6 pb-4 border-b border-white/5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {tier && (
              <span
                className={`text-[10px] uppercase tracking-wider font-semibold ${tier.color}`}
              >
                {tier.label}
              </span>
            )}
            {isModule && (
              <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                Draft Module
              </span>
            )}
            {!isModule && (
              <span className="text-[10px] text-zinc-600">
                Lines {(section as SpecSection).lineStart}&ndash;
                {(section as SpecSection).lineEnd}
              </span>
            )}
          </div>
          <h2 className="text-xl font-bold text-zinc-100">{title}</h2>
        </div>
        <button
          onClick={onPropose}
          className="shrink-0 ml-4 px-3 py-1.5 text-xs font-medium bg-accent-bright/10 text-accent-bright rounded hover:bg-accent-bright/20 transition-colors border border-accent-bright/20"
        >
          Propose Amendment
        </button>
      </div>

      {/* Content */}
      <div className="spec-content text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap font-mono">
        {section.content}
      </div>
    </div>
  );
}

function CrossRefsPanel({
  section,
  sections,
  onSelectSection,
}: {
  section: SpecSection | null;
  sections: SpecSection[];
  onSelectSection: (id: string) => void;
}) {
  if (!section) return null;

  const refs = CROSS_REFS[section.id];
  if (!refs) {
    return (
      <div className="p-4 text-[10px] text-zinc-600 italic">
        No cross-references for this section yet.
      </div>
    );
  }

  const relatedSections = (refs.related || [])
    .map((id) => sections.find((s) => s.id === id))
    .filter(Boolean) as SpecSection[];

  return (
    <div className="p-3 space-y-4">
      <h3 className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">
        Cross References
      </h3>

      {/* Related sections */}
      {relatedSections.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Related Sections
          </div>
          <div className="space-y-0.5">
            {relatedSections.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelectSection(s.id)}
                className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors truncate"
              >
                <span className="text-zinc-600 mr-1">§{s.id}</span>
                {s.title.replace(/^§\d+[a-z]?\.\s*/, "")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ADRs */}
      {refs.adrs && refs.adrs.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Architecture Decisions
          </div>
          <div className="space-y-0.5">
            {refs.adrs.map((adr) => (
              <div
                key={adr}
                className="px-2 py-1.5 text-xs text-indigo-400 bg-indigo-500/5 rounded"
              >
                {adr}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* GitHub Issues */}
      {refs.issues && refs.issues.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            GitHub Issues
          </div>
          <div className="space-y-0.5">
            {refs.issues.map((issue) => (
              <a
                key={issue}
                href={`https://github.com/staqsIO/optimus/issues/${issue.replace("#", "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-2 py-1.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/5 rounded transition-colors"
              >
                staqsIO/optimus{issue}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Agents */}
      {refs.agents && refs.agents.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Involved Agents
          </div>
          <div className="flex flex-wrap gap-1">
            {refs.agents.map((agent) => (
              <span
                key={agent}
                className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/10 text-emerald-400"
              >
                {agent}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Implementation files */}
      {refs.files && refs.files.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Key Files
          </div>
          <div className="space-y-0.5">
            {refs.files.map((file) => (
              <div
                key={file}
                className="px-2 py-1 text-[10px] text-zinc-500 font-mono truncate"
                title={file}
              >
                {file}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main Page ---

export default function SpecPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[60vh] text-zinc-500 text-sm">
          Loading spec...
        </div>
      }
    >
      <SpecPageInner />
    </Suspense>
  );
}

function SpecPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [sections, setSections] = useState<SpecSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showModules, setShowModules] = useState(false);
  const [amendTarget, setAmendTarget] = useState<
    SpecSection | SpecModule | null
  >(null);

  const selectedId = searchParams.get("section") || null;

  // Fetch and parse SPEC.md from GitHub via workstation/file endpoint
  const fetchSpec = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workstation/file?path=spec/SPEC.md`
      );
      if (!res.ok) {
        setError("Failed to load SPEC.md from GitHub.");
        return;
      }
      const data = await res.json();
      const parsed = parseSpecSections(data.content);
      setSections(parsed);
    } catch {
      setError("Could not reach the API. Is the dashboard backend running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSpec();
  }, [fetchSpec]);

  // Resolve selected section or module
  const selectedSection = useMemo(() => {
    if (!selectedId) return null;
    if (selectedId.startsWith("module:")) {
      const name = selectedId.replace("module:", "");
      return PROPOSED_MODULES.find((m) => m.name === name) || null;
    }
    return sections.find((s) => s.id === selectedId) || null;
  }, [selectedId, sections]);

  // Client-side search filter
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) return sections;
    const q = searchQuery.toLowerCase();
    return sections.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.content.toLowerCase().includes(q)
    );
  }, [sections, searchQuery]);

  const filteredModules = useMemo(() => {
    if (!searchQuery.trim()) return PROPOSED_MODULES;
    const q = searchQuery.toLowerCase();
    return PROPOSED_MODULES.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  function handleSelect(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("section", id);
    router.push(`/spec?${params.toString()}`);
  }

  if (loading) {
    return (
      <div className="flex flex-col md:flex-row h-[calc(100vh-48px)]">
        {/* Sidebar skeleton */}
        <div className="hidden md:block w-60 shrink-0 border-r border-white/5 p-4 space-y-3">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="h-5 rounded bg-surface-raised animate-pulse"
            />
          ))}
        </div>
        {/* Content skeleton */}
        <div className="flex-1 p-8 space-y-4">
          <div className="h-8 w-64 rounded bg-surface-raised animate-pulse" />
          <div className="h-4 w-96 rounded bg-surface-raised animate-pulse" />
          <div className="space-y-2 mt-8">
            {[...Array(8)].map((_, i) => (
              <div
                key={i}
                className="h-4 rounded bg-surface-raised animate-pulse"
                style={{ width: `${60 + Math.random() * 40}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="text-zinc-500 text-sm">{error}</div>
          <button
            onClick={() => {
              setError("");
              setLoading(true);
              fetchSpec();
            }}
            className="mt-3 text-xs text-accent-bright hover:text-accent transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-48px)]">
      {/* Mobile: section dropdown */}
      <div className="md:hidden border-b border-white/5 p-3">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search spec..."
          className="w-full px-2.5 py-1.5 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright mb-2"
        />
        <select
          value={selectedId || ""}
          onChange={(e) => {
            if (e.target.value) handleSelect(e.target.value);
            else router.push("/spec");
          }}
          className="w-full px-2.5 py-2 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-accent-bright"
        >
          <option value="">Overview</option>
          {filteredSections.map((s) => (
            <option key={s.id} value={s.id}>
              {"\u00A7"}{s.id} {s.title.replace(/^§\d+[a-z]?\.\s*/, "")}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop: Left sidebar section tree */}
      <div className="hidden md:block w-60 shrink-0 border-r border-white/5 overflow-y-auto">
        <div className="p-3">
          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search spec..."
            className="w-full px-2.5 py-1.5 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright mb-3"
          />

          {/* Overview link */}
          <button
            onClick={() => router.push("/spec")}
            className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors mb-3 ${
              !selectedId
                ? "bg-accent/10 text-accent-bright"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
            }`}
          >
            Overview
          </button>

          <SectionNav
            sections={filteredSections}
            modules={filteredModules}
            selectedId={selectedId}
            onSelect={handleSelect}
            showModules={showModules}
            onToggleModules={() => setShowModules((v) => !v)}
          />
        </div>
      </div>

      {/* Center: content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 md:px-8 py-4 md:py-8">
          <SpecContent
            section={selectedSection}
            onPropose={() => {
              if (selectedSection) setAmendTarget(selectedSection);
            }}
          />
        </div>
      </div>

      {/* Right sidebar: cross-references — hidden on mobile */}
      {selectedSection && "id" in selectedSection && (
        <div className="hidden lg:block w-56 shrink-0 border-l border-white/5 overflow-y-auto">
          <CrossRefsPanel
            section={selectedSection as SpecSection}
            sections={sections}
            onSelectSection={handleSelect}
          />
        </div>
      )}

      {/* Amendment modal */}
      {amendTarget && (
        <AmendmentModal
          section={amendTarget}
          onClose={() => setAmendTarget(null)}
          onSubmitted={() => setAmendTarget(null)}
        />
      )}
    </div>
  );
}
