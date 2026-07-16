import type { AgendaAction, AgendaItem, AgendaSection, SpecIndex, SpecSection, SpecRef, SpecDomain, SpecStatus } from "@/components/workstation/types";

// --- Conversation files ---

interface ConversationHeader {
  number: string;
  title: string;
  date?: string;
  author?: string;
  status?: string;
  participants?: string;
  references?: string;
  specReferences?: string;
  filename: string;
}

export function parseConversationHeader(
  content: string,
  filename: string
): ConversationHeader | null {
  const numMatch = filename.match(/^(\d{3})-/);
  if (!numMatch) return null;

  const lines = content.split("\n").slice(0, 20);
  const header: ConversationHeader = {
    number: numMatch[1],
    title: filename,
    filename,
  };

  for (const line of lines) {
    const titleMatch = line.match(/^#\s+(.+)$/);
    if (titleMatch && header.title === filename) {
      header.title = titleMatch[1];
    }
    const dateMatch = line.match(/^\*\*Date:\*\*\s+(.+)$/);
    if (dateMatch) header.date = dateMatch[1].trim();
    const statusMatch = line.match(/^\*\*Status:\*\*\s+(.+)$/);
    if (statusMatch) header.status = statusMatch[1].trim();
    const authorMatch = line.match(/^\*\*(?:Author|Participants):\*\*\s+(.+)$/);
    if (authorMatch) header.participants = authorMatch[1].trim();
    const refMatch = line.match(/^\*\*References:\*\*\s+(.+)$/);
    if (refMatch) header.references = refMatch[1].trim();
    const specRefMatch = line.match(/^\*\*Spec references:\*\*\s+(.+)$/i);
    if (specRefMatch) header.specReferences = specRefMatch[1].trim();
  }

  return header;
}

// --- Decision (ADR) files ---

interface DecisionHeader {
  number: string;
  title: string;
  status?: string;
  date?: string;
  decidedBy?: string;
  filename: string;
}

export function parseDecisionHeader(
  content: string,
  filename: string
): DecisionHeader | null {
  const numMatch = filename.match(/^(\d{3})-/);
  if (!numMatch) return null;

  const lines = content.split("\n").slice(0, 20);
  const header: DecisionHeader = {
    number: numMatch[1],
    title: filename,
    filename,
  };

  for (const line of lines) {
    const titleMatch = line.match(/^#\s+(?:ADR-\d+:\s+)?(.+)$/);
    if (titleMatch && header.title === filename) {
      header.title = titleMatch[1];
    }
    const statusMatch = line.match(/^\*\*Status:\*\*\s+(.+)$/);
    if (statusMatch) header.status = statusMatch[1].trim();
    const dateMatch = line.match(/^\*\*Date:\*\*\s+(.+)$/);
    if (dateMatch) header.date = dateMatch[1].trim();
    const decidedMatch = line.match(/^\*\*Decided by:\*\*\s+(.+)$/);
    if (decidedMatch) header.decidedBy = decidedMatch[1].trim();
  }

  return header;
}

// --- Open Questions ---

interface OpenQuestionItem {
  text: string;
  resolved: boolean;
  resolution?: string;
  category?: string;
  deferred?: boolean;
  revisitTrigger?: string;
}

interface SpecPatch {
  patch: string;
  section: string;
  change: string;
}

interface OpenQuestionsResult {
  openItems: OpenQuestionItem[];
  deferredItems: OpenQuestionItem[];
  specPatches: SpecPatch[];
}

export function parseOpenQuestions(content: string): OpenQuestionsResult {
  const result: OpenQuestionsResult = {
    openItems: [],
    deferredItems: [],
    specPatches: [],
  };

  const sections = content.split(/^---$/m);
  let currentSection = "";

  for (const section of sections) {
    const lines = section.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect section headers
      const sectionHeader = line.match(/^##\s+(.+)$/);
      if (sectionHeader) {
        currentSection = sectionHeader[1].trim().toLowerCase();
        continue;
      }

      // Current Open Questions — unchecked items
      if (currentSection.includes("current open questions")) {
        const openMatch = line.match(/^- \[ \]\s+(.+)$/);
        if (openMatch) {
          result.openItems.push({
            text: openMatch[1].replace(/\*\*/g, ""),
            resolved: false,
          });
        }
      }

      // Evaluated and Deferred — items with DEFERRED/REJECTED
      if (currentSection.includes("evaluated and deferred")) {
        const itemMatch = line.match(/^- \[[ x]\]\s+(.+)$/);
        if (itemMatch) {
          const text = itemMatch[1].replace(/\*\*/g, "");
          const isDeferred =
            /DEFERRED|REJECTED/i.test(text);
          // Look ahead for revisit trigger
          let revisitTrigger: string | undefined;
          if (i + 1 < lines.length) {
            const triggerMatch = lines[i + 1].match(
              /Revisit trigger:\s*(.+)/i
            );
            if (triggerMatch) revisitTrigger = triggerMatch[1].trim();
          }
          if (isDeferred) {
            result.deferredItems.push({
              text,
              resolved: false,
              deferred: true,
              revisitTrigger,
            });
          }
        }
      }

      // Spec Patches Required — table rows
      if (currentSection.includes("spec patches required")) {
        const pipeMatch = line.match(
          /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|$/
        );
        if (
          pipeMatch &&
          !line.includes("---") &&
          !line.toLowerCase().includes("patch") &&
          !line.toLowerCase().includes("section") &&
          !line.toLowerCase().includes("change")
        ) {
          const [, patch, section, change] = pipeMatch;
          // Skip header row
          if (
            patch.trim() !== "Patch" &&
            !patch.includes("---")
          ) {
            result.specPatches.push({
              patch: patch.trim(),
              section: section.trim(),
              change: change.trim(),
            });
          }
        }
      }
    }
  }

  return result;
}

// --- Research Registry ---

interface ResearchStats {
  total: number;
  byStatus: Record<string, number>;
  phase1Items: { id: string; question: string; status: string }[];
}

export function parseResearchRegistry(content: string): ResearchStats {
  const stats: ResearchStats = {
    total: 0,
    byStatus: {},
    phase1Items: [],
  };

  const lines = content.split("\n");
  let inTable = false;

  for (const line of lines) {
    // Detect summary table header
    if (line.includes("| ID") && line.includes("Status")) {
      inTable = true;
      continue;
    }
    // Skip separator row
    if (inTable && /^\|[\s-|]+\|$/.test(line)) continue;

    // End of table
    if (inTable && !line.startsWith("|")) {
      inTable = false;
      continue;
    }

    if (inTable) {
      const cols = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length >= 6) {
        const [id, , question, phase, , status] = cols;
        stats.total++;
        stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
        if (phase.includes("1")) {
          stats.phase1Items.push({ id, question, status });
        }
      }
    }
  }

  return stats;
}

// --- Changelog ---

interface ChangelogEntry {
  version: string;
  date: string;
  status: string;
  summary: string;
  changes: string[];
}

export function parseChangelog(content: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = content.split("\n");
  let current: ChangelogEntry | null = null;

  for (const line of lines) {
    const versionMatch = line.match(
      /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*(?:—\s*(.+))?$/
    );
    if (versionMatch) {
      if (current) entries.push(current);
      current = {
        version: versionMatch[1],
        date: versionMatch[2],
        status: (versionMatch[3] || "RELEASED").trim(),
        summary: "",
        changes: [],
      };
      continue;
    }

    if (current) {
      // First non-empty, non-header line after version is summary
      if (
        !current.summary &&
        line.trim() &&
        !line.startsWith("#") &&
        !line.startsWith("-") &&
        !line.startsWith("|")
      ) {
        current.summary = line.trim();
        continue;
      }
      // Collect change lines
      const changeMatch = line.match(/^- (.+)$/);
      if (changeMatch) {
        current.changes.push(changeMatch[1]);
      }
    }
  }
  if (current) entries.push(current);

  return entries;
}

// --- Spec Index parser (from per-section files + _index.yaml) ---

interface IndexYamlSection {
  id: string;
  file: string;
  domain: SpecDomain;
  status: SpecStatus;
  phase: number;
}

interface IndexYaml {
  version: string;
  domains: Record<string, { color: string; label: string }>;
  sections: IndexYamlSection[];
}

/** Minimal YAML parser — handles the flat structure of _index.yaml */
export function parseIndexYaml(raw: string): IndexYaml {
  const result: IndexYaml = { version: "unknown", domains: {}, sections: [] };
  const lines = raw.split("\n");
  let context: "root" | "domains" | "domain-entry" | "sections" | "section-entry" = "root";
  let currentDomainKey = "";
  let currentSection: Partial<IndexYamlSection> = {};

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level keys
    const topMatch = trimmed.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (topMatch && !trimmed.startsWith("  ")) {
      const [, key, val] = topMatch;
      if (key === "version") result.version = val;
      if (key === "domains") context = "domains";
      else if (key === "sections") context = "sections";
      else context = "root";
      continue;
    }

    if (context === "domains") {
      const domainKeyMatch = trimmed.match(/^  (\w+):$/);
      if (domainKeyMatch) {
        currentDomainKey = domainKeyMatch[1];
        result.domains[currentDomainKey] = { color: "", label: "" };
        context = "domain-entry";
        continue;
      }
      // Check for inline domain definition
      const domainInlineMatch = trimmed.match(/^  (\w+):\s*\{(.+)\}\s*$/);
      if (domainInlineMatch) {
        const [, key, body] = domainInlineMatch;
        const colorMatch = body.match(/color:\s*"([^"]+)"/);
        const labelMatch = body.match(/label:\s*"([^"]+)"/);
        result.domains[key] = {
          color: colorMatch?.[1] || "",
          label: labelMatch?.[1] || key,
        };
        continue;
      }
    }

    if (context === "domain-entry") {
      const propMatch = trimmed.match(/^\s{4}(\w+):\s*"?([^"]*)"?\s*$/);
      if (propMatch) {
        const [, key, val] = propMatch;
        if (key === "color") result.domains[currentDomainKey].color = val;
        if (key === "label") result.domains[currentDomainKey].label = val;
        continue;
      }
      // Back to domains level
      const nextDomainMatch = trimmed.match(/^  (\w+):$/);
      if (nextDomainMatch) {
        currentDomainKey = nextDomainMatch[1];
        result.domains[currentDomainKey] = { color: "", label: "" };
        continue;
      }
      if (!trimmed.startsWith("  ")) {
        context = "root";
      }
    }

    if (context === "sections") {
      // New section entry
      if (trimmed.match(/^\s{2}-\s+/)) {
        if (currentSection.id) {
          result.sections.push(currentSection as IndexYamlSection);
        }
        currentSection = {};
        const idMatch = trimmed.match(/id:\s*"?([^"]+)"?\s*$/);
        if (idMatch) currentSection.id = idMatch[1];
        context = "section-entry";
        continue;
      }
    }

    if (context === "section-entry") {
      // Next section entry
      if (trimmed.match(/^\s{2}-\s+/)) {
        if (currentSection.id) {
          result.sections.push(currentSection as IndexYamlSection);
        }
        currentSection = {};
        const idMatch = trimmed.match(/id:\s*"?([^"]+)"?\s*$/);
        if (idMatch) currentSection.id = idMatch[1];
        continue;
      }
      const propMatch = trimmed.match(/^\s{4}(\w+):\s*"?([^"]*)"?\s*$/);
      if (propMatch) {
        const [, key, val] = propMatch;
        if (key === "id") currentSection.id = val;
        if (key === "file") currentSection.file = val;
        if (key === "domain") currentSection.domain = val as SpecDomain;
        if (key === "status") currentSection.status = val as SpecStatus;
        if (key === "phase") currentSection.phase = parseInt(val, 10);
        continue;
      }
      if (!trimmed.startsWith("  ")) {
        if (currentSection.id) {
          result.sections.push(currentSection as IndexYamlSection);
          currentSection = {};
        }
        context = "root";
      }
    }
  }
  // Flush last section
  if (currentSection.id) {
    result.sections.push(currentSection as IndexYamlSection);
  }
  return result;
}

/** Build SpecIndex from _index.yaml metadata + per-section file contents */
export function buildSpecIndexFromFiles(
  indexYaml: IndexYaml,
  sectionContents: Record<string, string>, // keyed by filename
): SpecIndex {
  const sections: SpecSection[] = [];
  const sectionMap: Record<string, SpecSection> = {};

  for (const entry of indexYaml.sections) {
    const raw = sectionContents[entry.file] || "";
    const lines = raw.split("\n");

    // Extract heading from file
    let heading = "";
    let contentStartIdx = 0;
    const headingRegex = /^(#{2,3})\s+(\d+(?:\.\d+)?)\.\s+(.+)$/;

    // Parse all headings for subsections
    const fileHeadings: { line: number; id: string; heading: string; level: 2 | 3 }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(headingRegex);
      if (m) {
        fileHeadings.push({
          line: i,
          id: m[2],
          heading: m[3].replace(/\s*\(.*\)\s*$/, "").trim(),
          level: m[1].length as 2 | 3,
        });
      }
    }

    // Primary section (first heading)
    if (fileHeadings.length > 0) {
      heading = fileHeadings[0].heading;
      contentStartIdx = fileHeadings[0].line + 1;
    }

    // Build main section — content is everything after the first heading
    const primaryContent = fileHeadings.length > 1
      ? lines.slice(contentStartIdx, fileHeadings[1].line).join("\n").trim()
      : lines.slice(contentStartIdx).join("\n").trim();

    const section: SpecSection = {
      id: entry.id,
      heading,
      level: 2,
      content: primaryContent,
      file: entry.file,
      domain: entry.domain,
      status: entry.status,
      phase: entry.phase,
    };
    sections.push(section);
    sectionMap[section.id] = section;

    // Subsections (### headings within the file)
    for (let h = 1; h < fileHeadings.length; h++) {
      const sub = fileHeadings[h];
      if (sub.level !== 3) continue;
      const subStart = sub.line + 1;
      const subEnd = h + 1 < fileHeadings.length ? fileHeadings[h + 1].line : lines.length;
      const subContent = lines.slice(subStart, subEnd).join("\n").trim();

      const subSection: SpecSection = {
        id: sub.id,
        heading: sub.heading,
        level: 3,
        content: subContent,
        file: entry.file,
        domain: entry.domain,
        status: entry.status,
        phase: entry.phase,
      };
      sections.push(subSection);
      sectionMap[subSection.id] = subSection;
    }
  }

  return { version: indexYaml.version, sections, sectionMap };
}

// --- SPEC.md section parser (legacy fallback) ---

export function parseSpecSections(content: string): SpecIndex {
  const sections: SpecSection[] = [];
  const sectionMap: Record<string, SpecSection> = {};
  const lines = content.split("\n");

  // Extract version from first 10 lines
  let version = "unknown";
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const vMatch = lines[i].match(/v(\d+\.\d+\.\d+)/);
    if (vMatch) {
      version = vMatch[1];
      break;
    }
  }

  // Find heading boundaries: ## N. Title or ### N.M. Title
  const headingRegex = /^(#{2,3})\s+(\d+(?:\.\d+)?)\.\s+(.+)$/;
  const headingIndices: { line: number; id: string; heading: string; level: 2 | 3 }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRegex);
    if (m) {
      headingIndices.push({
        line: i,
        id: m[2],
        heading: m[3].replace(/\s*\(.*\)\s*$/, "").trim(), // strip trailing (vX.Y.Z)
        level: m[1].length as 2 | 3,
      });
    }
  }

  // Build sections by capturing content between headings
  for (let i = 0; i < headingIndices.length; i++) {
    const start = headingIndices[i].line + 1;
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1].line : lines.length;
    const sectionContent = lines.slice(start, end).join("\n").trim();

    const section: SpecSection = {
      id: headingIndices[i].id,
      heading: headingIndices[i].heading,
      level: headingIndices[i].level,
      content: sectionContent,
      headingLine: headingIndices[i].line,
      contentStart: start,
      contentEnd: end,
    };
    sections.push(section);
    sectionMap[section.id] = section;
  }

  return { version, sections, sectionMap };
}

// --- § reference extractor ---

export function extractSpecRefs(text: string): SpecRef[] {
  const seen = new Set<string>();
  const refs: SpecRef[] = [];
  const regex = /§(\d+(?:\.\d+)?)\s*([^|,§\n]{0,40})?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const sectionId = match[1];
    if (seen.has(sectionId)) continue;
    seen.add(sectionId);
    const label = match[2]?.trim() || "";
    refs.push({
      sectionId,
      raw: label ? `§${sectionId} ${label}` : `§${sectionId}`,
    });
  }

  return refs;
}

// --- Assemble agenda sections from parsed data ---

export function assembleAgenda(opts: {
  conversations: ConversationHeader[];
  decisions: DecisionHeader[];
  openQuestions: OpenQuestionsResult | null;
  researchStats: ResearchStats | null;
  changelogEntries: ChangelogEntry[];
  contentMap?: Record<string, string>;
  specIndex?: SpecIndex | null;
}): AgendaSection[] {
  const sections: AgendaSection[] = [];
  const cm = opts.contentMap || {};

  // Helper: build "Propose revision" action for items with spec refs
  function proposeRevisionAction(specRefs: SpecRef[], item: { title: string; file: string }): AgendaAction | null {
    if (specRefs.length === 0) return null;
    const refs = specRefs.map((r) => r.raw).join(", ");
    // Include per-section files in context paths when spec sections have file info
    const specContextPaths: string[] = [];
    if (opts.specIndex) {
      for (const ref of specRefs) {
        const section = opts.specIndex.sectionMap[ref.sectionId];
        if (section?.file) {
          const path = `spec/spec/${section.file}`;
          if (!specContextPaths.includes(path)) specContextPaths.push(path);
        }
      }
    }
    if (specContextPaths.length === 0) {
      specContextPaths.push("spec/SPEC.md");
    }
    return {
      label: "Propose revision",
      mode: "pr" as const,
      contextPaths: [...specContextPaths, item.file],
      promptTemplate: `Propose a revision to ${refs}. Context: "${item.title}". Show the proposed changes to the affected section(s) and update CHANGELOG.md.`,
    };
  }

  // 1. Needs Your Review — conversations with pending/proposal status
  const pendingConversations = opts.conversations.filter((c) => {
    if (!c.status) return false;
    const s = c.status.toLowerCase();
    return s.includes("pending") || s.includes("proposal");
  });
  if (pendingConversations.length > 0) {
    sections.push({
      id: "pending-review",
      title: "Needs Your Review",
      description: "Proposals and entries awaiting board review",
      items: pendingConversations.map((c) => {
        const refSource = [c.specReferences || "", c.references || "", cm[c.filename] || ""].join("\n");
        const specRefs = extractSpecRefs(refSource);
        const file = `spec/conversation/${c.filename}`;
        const actions: AgendaAction[] = [
          {
            label: "Discuss",
            mode: "qa" as const,
            contextPaths: [file],
            promptTemplate: `I'd like to discuss conversation entry ${c.number}: "${c.title}". What are the key proposals and what needs to be decided?`,
          },
          {
            label: "Draft response",
            mode: "pr" as const,
            contextPaths: [file, "spec/SPEC.md"],
            promptTemplate: `Write a board response to conversation entry ${c.number}: "${c.title}". Address the proposals and capture any decisions.`,
          },
        ];
        const revision = proposeRevisionAction(specRefs, { title: c.title, file });
        if (revision) actions.push(revision);
        return {
          id: `conv-${c.number}`,
          category: "pending-review" as const,
          title: c.title,
          summary: c.status || "Pending review",
          priority: "high" as const,
          source: { file },
          metadata: {
            ...(c.date ? { date: c.date } : {}),
            ...(c.participants ? { participants: c.participants } : {}),
          },
          content: cm[c.filename],
          specRefs: specRefs.length > 0 ? specRefs : undefined,
          actions,
        };
      }),
    });
  }

  // 2. Open Questions
  if (opts.openQuestions && opts.openQuestions.openItems.length > 0) {
    sections.push({
      id: "open-questions",
      title: "Open Questions",
      description: "Unresolved governance questions awaiting decisions",
      items: opts.openQuestions.openItems.map((q, i) => {
        const specRefs = extractSpecRefs(q.text);
        const file = "spec/open-questions/README.md";
        const actions: AgendaAction[] = [
          {
            label: "Discuss",
            mode: "qa" as const,
            contextPaths: [file, "spec/SPEC.md"],
            promptTemplate: `Help me think through this open question: "${q.text}"`,
          },
        ];
        const revision = proposeRevisionAction(specRefs, { title: q.text.slice(0, 80), file });
        if (revision) actions.push(revision);
        return {
          id: `oq-${i}`,
          category: "open-question" as const,
          title: q.text.slice(0, 120) + (q.text.length > 120 ? "..." : ""),
          summary: q.text,
          priority: "high" as const,
          source: { file, section: "Current Open Questions" },
          metadata: {},
          content: cm["open-questions/README.md"],
          specRefs: specRefs.length > 0 ? specRefs : undefined,
          actions,
        };
      }),
    });
  }

  // 3. Spec Patches Required
  if (opts.openQuestions && opts.openQuestions.specPatches.length > 0) {
    sections.push({
      id: "spec-patches",
      title: "Spec Patches Required",
      description: "Known spec corrections that need to be applied",
      items: opts.openQuestions.specPatches.map((p, i) => {
        const specRefs = extractSpecRefs(p.section);
        return {
          id: `patch-${i}`,
          category: "spec-patch" as const,
          title: `${p.section}: ${p.patch}`,
          summary: p.change,
          priority: "medium" as const,
          source: {
            file: "spec/open-questions/README.md",
            section: "Spec Patches Required",
          },
          metadata: { section: p.section },
          content: cm["open-questions/README.md"],
          specRefs: specRefs.length > 0 ? specRefs : undefined,
          actions: [
            {
              label: "Apply patch",
              mode: "pr" as const,
              contextPaths: [
                "spec/SPEC.md",
                "spec/open-questions/README.md",
                "spec/CHANGELOG.md",
              ],
              promptTemplate: `Apply this spec patch: ${p.section} — ${p.change}. Update SPEC.md and the CHANGELOG accordingly.`,
            },
          ],
        };
      }),
    });
  }

  // 4. Draft Releases
  const drafts = opts.changelogEntries.filter(
    (e) => e.status.toUpperCase() === "DRAFT"
  );
  if (drafts.length > 0) {
    sections.push({
      id: "draft-releases",
      title: "Draft Releases",
      description: "Changelog entries marked as DRAFT",
      items: drafts.map((d) => ({
        id: `draft-${d.version}`,
        category: "pending-review" as const,
        title: `v${d.version} — ${d.status}`,
        summary: d.summary || `${d.changes.length} changes`,
        priority: "medium" as const,
        source: { file: "spec/CHANGELOG.md" },
        metadata: { date: d.date, version: d.version },
        content: cm["CHANGELOG.md"],
        actions: [
          {
            label: "Review",
            mode: "qa" as const,
            contextPaths: ["spec/CHANGELOG.md"],
            promptTemplate: `Review the DRAFT changelog for v${d.version}. Is it ready for release?`,
          },
          {
            label: "Finalize release",
            mode: "pr" as const,
            contextPaths: [
              "spec/CHANGELOG.md",
              "spec/SPEC.md",
            ],
            promptTemplate: `Finalize the v${d.version} changelog entry: change status from DRAFT to RELEASED.`,
          },
        ],
      })),
    });
  }

  // 5. Recent Decisions (last 3, informational)
  const recentDecisions = opts.decisions.slice(0, 3);
  if (recentDecisions.length > 0) {
    sections.push({
      id: "recent-decisions",
      title: "Recent Decisions",
      description: "Latest architecture decisions for reference",
      items: recentDecisions.map((d) => {
        const specRefs = extractSpecRefs(cm[d.filename] || "");
        const file = `spec/decisions/${d.filename}`;
        const actions: AgendaAction[] = [
          {
            label: "Review",
            mode: "qa" as const,
            contextPaths: [file],
            promptTemplate: `Summarize ADR-${d.number}: "${d.title}". What was decided and why?`,
          },
        ];
        const revision = proposeRevisionAction(specRefs, { title: d.title, file });
        if (revision) actions.push(revision);
        return {
          id: `adr-${d.number}`,
          category: "decision" as const,
          title: d.title,
          summary: d.status || "Accepted",
          priority: "low" as const,
          source: { file },
          metadata: {
            ...(d.date ? { date: d.date } : {}),
            ...(d.decidedBy ? { decidedBy: d.decidedBy } : {}),
            ...(d.status ? { status: d.status } : {}),
          },
          content: cm[d.filename],
          specRefs: specRefs.length > 0 ? specRefs : undefined,
          actions,
        };
      }),
    });
  }

  // 6. Deferred Items
  if (opts.openQuestions && opts.openQuestions.deferredItems.length > 0) {
    sections.push({
      id: "deferred-items",
      title: "Deferred Items",
      description: "Previously evaluated proposals with revisit triggers",
      items: opts.openQuestions.deferredItems.map((d, i) => {
        const specRefs = extractSpecRefs(d.text);
        const file = "spec/open-questions/README.md";
        const actions: AgendaAction[] = [
          {
            label: "Discuss",
            mode: "qa" as const,
            contextPaths: [file, "spec/SPEC.md"],
            promptTemplate: `Should we revisit this deferred item? "${d.text}"`,
          },
        ];
        const revision = proposeRevisionAction(specRefs, { title: d.text.slice(0, 80), file });
        if (revision) actions.push(revision);
        return {
          id: `deferred-${i}`,
          category: "deferred" as const,
          title: d.text.slice(0, 120) + (d.text.length > 120 ? "..." : ""),
          summary: d.revisitTrigger
            ? `Revisit trigger: ${d.revisitTrigger}`
            : d.text,
          priority: "low" as const,
          source: { file, section: "Evaluated and Deferred" },
          metadata: {
            ...(d.revisitTrigger ? { revisitTrigger: d.revisitTrigger } : {}),
          },
          content: cm["open-questions/README.md"],
          specRefs: specRefs.length > 0 ? specRefs : undefined,
          actions,
        };
      }),
    });
  }

  // 7. Research Questions (stats card)
  if (opts.researchStats && opts.researchStats.total > 0) {
    const { total, byStatus, phase1Items } = opts.researchStats;
    const statusSummary = Object.entries(byStatus)
      .map(([s, n]) => `${n} ${s.toLowerCase()}`)
      .join(", ");
    sections.push({
      id: "research-questions",
      title: "Research Questions",
      description: `${total} questions tracked: ${statusSummary}`,
      items: phase1Items.length > 0
        ? phase1Items.map((rq) => {
            const specRefs = extractSpecRefs(rq.question);
            return {
              id: `rq-${rq.id}`,
              category: "research" as const,
              title: `${rq.id}: ${rq.question.slice(0, 100)}${rq.question.length > 100 ? "..." : ""}`,
              summary: `Status: ${rq.status}`,
              priority: "low" as const,
              source: { file: "spec/research-questions/REGISTRY.md" },
              metadata: { status: rq.status },
              content: cm["research-questions/REGISTRY.md"],
              specRefs: specRefs.length > 0 ? specRefs : undefined,
              actions: [
                {
                  label: "Discuss",
                  mode: "qa" as const,
                  contextPaths: [
                    "spec/research-questions/REGISTRY.md",
                    "spec/SPEC.md",
                  ],
                  promptTemplate: `What's the status of research question ${rq.id}: "${rq.question}"? What evidence do we need?`,
                },
              ],
            };
          })
        : [],
    });
  }

  return sections;
}
