import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken } from "@/lib/auth";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";
import { REPO_OWNER, REPO_NAME } from "@/lib/github";
import {
  parseConversationHeader,
  parseDecisionHeader,
  parseOpenQuestions,
  parseResearchRegistry,
  parseChangelog,
  parseSpecSections,
  parseIndexYaml,
  buildSpecIndexFromFiles,
  assembleAgenda,
} from "@/lib/agenda-parser";
import type { AgendaData, AgendaItem } from "@/components/workstation/types";

interface GitHubTreeItem {
  name: string;
  type: string;
  path: string;
}

async function fetchGitHubDir(
  ghToken: string,
  dirPath: string
): Promise<GitHubTreeItem[]> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${dirPath}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );
  if (!res.ok) throw new Error(`Failed to list ${dirPath}: ${res.status}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error(`${dirPath} is not a directory`);
  return items;
}

async function fetchGitHubFile(
  ghToken: string,
  filePath: string
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github.v3.raw",
      },
    }
  );
  if (!res.ok) throw new Error(`Failed to fetch ${filePath}: ${res.status}`);
  return res.text();
}

export async function GET(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const errors: { source: string; message: string }[] = [];

  // Phase 1: Parallel directory listings + known files + spec index
  const [convDirResult, decDirResult, openQResult, registryResult, changelogResult, specIndexResult] =
    await Promise.allSettled([
      fetchGitHubDir(ghToken, "spec/conversation"),
      fetchGitHubDir(ghToken, "spec/decisions"),
      fetchGitHubFile(ghToken, "spec/open-questions/README.md"),
      fetchGitHubFile(ghToken, "spec/research-questions/REGISTRY.md"),
      fetchGitHubFile(ghToken, "spec/CHANGELOG.md"),
      fetchGitHubFile(ghToken, "spec/spec/_index.yaml"),
    ]);

  // Collect conversation file names (NNN-*.md, sorted descending, last 5)
  let convFiles: string[] = [];
  if (convDirResult.status === "fulfilled") {
    convFiles = convDirResult.value
      .filter((f) => f.type === "file" && /^\d{3}-/.test(f.name) && f.name.endsWith(".md"))
      .map((f) => f.name)
      .sort()
      .reverse()
      .slice(0, 5);
  } else {
    errors.push({ source: "conversation directory", message: String(convDirResult.reason) });
  }

  // Collect decision file names (NNN-*.md, sorted descending)
  let decFiles: string[] = [];
  if (decDirResult.status === "fulfilled") {
    decFiles = decDirResult.value
      .filter((f) => f.type === "file" && /^\d{3}-/.test(f.name) && f.name.endsWith(".md"))
      .map((f) => f.name)
      .sort()
      .reverse();
  } else {
    errors.push({ source: "decisions directory", message: String(decDirResult.reason) });
  }

  // Phase 2: Fetch individual conversation and decision files
  const convFetches = convFiles.map((name) =>
    fetchGitHubFile(ghToken, `spec/conversation/${name}`)
      .then((content) => ({ name, content }))
      .catch((err) => {
        errors.push({ source: `conversation/${name}`, message: String(err) });
        return null;
      })
  );

  const decFetches = decFiles.map((name) =>
    fetchGitHubFile(ghToken, `spec/decisions/${name}`)
      .then((content) => ({ name, content }))
      .catch((err) => {
        errors.push({ source: `decisions/${name}`, message: String(err) });
        return null;
      })
  );

  const [convResults, decResults] = await Promise.all([
    Promise.all(convFetches),
    Promise.all(decFetches),
  ]);

  // Build content map keyed by filename for inline rendering
  const contentMap: Record<string, string> = {};

  // Parse conversations
  const validConvResults = convResults.filter(
    (r): r is { name: string; content: string } => r !== null
  );
  for (const r of validConvResults) {
    contentMap[r.name] = r.content;
  }
  const conversations = validConvResults
    .map((r) => parseConversationHeader(r.content, r.name))
    .filter((h): h is NonNullable<typeof h> => h !== null);

  // Parse decisions
  const validDecResults = decResults.filter(
    (r): r is { name: string; content: string } => r !== null
  );
  for (const r of validDecResults) {
    contentMap[r.name] = r.content;
  }
  const decisions = validDecResults
    .map((r) => parseDecisionHeader(r.content, r.name))
    .filter((h): h is NonNullable<typeof h> => h !== null);

  // Parse open questions
  let openQuestions = null;
  if (openQResult.status === "fulfilled") {
    openQuestions = parseOpenQuestions(openQResult.value);
    contentMap["open-questions/README.md"] = openQResult.value;
  } else {
    errors.push({ source: "open-questions/README.md", message: String(openQResult.reason) });
  }

  // Parse research registry
  let researchStats = null;
  if (registryResult.status === "fulfilled") {
    researchStats = parseResearchRegistry(registryResult.value);
    contentMap["research-questions/REGISTRY.md"] = registryResult.value;
  } else {
    errors.push({ source: "research-questions/REGISTRY.md", message: String(registryResult.reason) });
  }

  // Parse changelog
  let changelogEntries: ReturnType<typeof parseChangelog> = [];
  if (changelogResult.status === "fulfilled") {
    changelogEntries = parseChangelog(changelogResult.value);
    contentMap["CHANGELOG.md"] = changelogResult.value;
  } else {
    errors.push({ source: "CHANGELOG.md", message: String(changelogResult.reason) });
  }

  // Parse spec from per-section files (preferred) or fall back to monolithic SPEC.md
  let specIndex = null;
  if (specIndexResult.status === "fulfilled") {
    try {
      const indexYaml = parseIndexYaml(specIndexResult.value);
      // Parallel-fetch all section files listed in the index
      const sectionFetchResults = await Promise.allSettled(
        indexYaml.sections.map((s) =>
          fetchGitHubFile(ghToken, `spec/spec/${s.file}`)
            .then((content) => ({ file: s.file, content }))
        )
      );
      const sectionContents: Record<string, string> = {};
      for (const result of sectionFetchResults) {
        if (result.status === "fulfilled") {
          sectionContents[result.value.file] = result.value.content;
        }
      }
      specIndex = buildSpecIndexFromFiles(indexYaml, sectionContents);
    } catch (err) {
      errors.push({ source: "spec/_index.yaml parse", message: String(err) });
    }
  }
  // Fallback: try monolithic SPEC.md if per-section approach failed
  if (!specIndex) {
    try {
      const specContent = await fetchGitHubFile(ghToken, "spec/SPEC.md");
      specIndex = parseSpecSections(specContent);
    } catch (err) {
      errors.push({ source: "SPEC.md", message: String(err) });
    }
  }

  // Assemble
  const sections = assembleAgenda({
    conversations,
    decisions,
    openQuestions,
    researchStats,
    changelogEntries,
    contentMap,
    specIndex,
  });

  // Enrich with ops data (best-effort — don't fail the agenda if backend is down)
  const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";

  // Per-user JWT — caller already passed the GitHub session gate above; this
  // mints a board JWT scoped to the calling user instead of sharing
  // OPS_API_SECRET. If the JWT mint fails (no session), skip the enrichment
  // rather than crashing the agenda (P3: best-effort enrichment).
  const opsHeadersOrNull = await getOpsAuthHeaders(req);
  const opsHeaders: Record<string, string> = opsHeadersOrNull || {};

  const [decisionsResult, briefingResult, proposalsResult] = await Promise.allSettled([
    fetch(`${OPS_API_URL}/api/strategic-decisions`, { headers: opsHeaders })
      .then(r => r.ok ? r.json() : null),
    fetch(`${OPS_API_URL}/api/briefing`, { headers: opsHeaders })
      .then(r => r.ok ? r.json() : null),
    fetch(`${OPS_API_URL}/api/spec-proposals?status=pending`, { headers: opsHeaders })
      .then(r => r.ok ? r.json() : null),
  ]);

  // Add Strategic Decisions section if we got data
  if (decisionsResult.status === "fulfilled" && decisionsResult.value?.decisions?.length > 0) {
    const decisionItems: AgendaItem[] = decisionsResult.value.decisions.map((d: any, i: number) => ({
      id: `sd-${d.id || i}`,
      category: "strategic-decision" as const,
      title: d.title || "Untitled Decision",
      summary: d.description || "",
      priority: d.urgency === "high" ? "high" as const : d.urgency === "low" ? "low" as const : "medium" as const,
      source: { file: "autobot-inbox/strategic-decisions" },
      metadata: {
        ...(d.board_verdict && { verdict: d.board_verdict }),
        ...(d.decided_at && { decidedAt: d.decided_at }),
        ...(d.category && { decisionCategory: d.category }),
      },
      actions: d.board_verdict ? [] : [
        { label: "Discuss", mode: "qa" as const, contextPaths: [], promptTemplate: `Regarding strategic decision "${d.title}": ${d.description}` },
      ],
    }));

    sections.push({
      id: "strategic-decisions",
      title: "Strategic Decisions",
      description: "Agent-proposed decisions requiring board review",
      items: decisionItems,
    });
  }

  // Add Agent Proposals section if we got pending proposals
  if (proposalsResult.status === "fulfilled" && proposalsResult.value?.proposals?.length > 0) {
    const proposalItems: AgendaItem[] = proposalsResult.value.proposals.map((p: any) => {
      // Extract spec section refs from the sections JSONB
      const specRefs = Array.isArray(p.sections)
        ? p.sections.map((s: any) => ({
            sectionId: s.sectionId,
            raw: `\u00A7${s.sectionId} ${s.file || ""}`.trim(),
          }))
        : [];

      return {
        id: `proposal-${p.id}`,
        category: "spec-patch" as const,
        title: p.title,
        summary: p.summary,
        priority: "high" as const,
        source: { file: `agent:${p.agent_name || p.agent_tier}` },
        metadata: {
          proposalId: p.id,
          agentTier: p.agent_tier,
          ...(p.agent_name && { agentName: p.agent_name }),
          ...(p.revision_of && { revisionOf: p.revision_of }),
          sectionCount: String(Array.isArray(p.sections) ? p.sections.length : 0),
        },
        specRefs,
        actions: [
          {
            label: "Review",
            mode: "qa" as const,
            contextPaths: [],
            promptTemplate: `Review agent proposal "${p.title}": ${p.summary}`,
          },
        ],
      };
    });

    sections.push({
      id: "agent-proposals",
      title: "Agent Proposals",
      description: "Spec changes proposed by agents, awaiting board review",
      items: proposalItems,
    });
  }

  // Add Today's Numbers section from briefing stats
  if (briefingResult.status === "fulfilled" && briefingResult.value?.stats) {
    const s = briefingResult.value.stats;
    const statItems: AgendaItem[] = [];

    if (Number(s.drafts_awaiting_review) > 0) {
      statItems.push({
        id: "ops-drafts-pending",
        category: "operational-stat" as const,
        title: `${s.drafts_awaiting_review} drafts awaiting review`,
        summary: `${s.drafts_created_today || 0} created today, ${s.drafts_approved_today || 0} approved, ${s.drafts_rejected_today || 0} rejected`,
        priority: "high" as const,
        source: { file: "autobot-inbox/drafts" },
        metadata: {},
        actions: [],
      });
    }

    statItems.push({
      id: "ops-budget",
      category: "operational-stat" as const,
      title: `Budget: $${Number(s.cost_today_usd || 0).toFixed(2)} / $${Number(s.budget_today_usd || 20).toFixed(2)}`,
      summary: `${s.emails_received_today || 0} emails received, ${s.emails_triaged_today || 0} triaged`,
      priority: Number(s.cost_today_usd) > Number(s.budget_today_usd) * 0.8 ? "high" as const : "low" as const,
      source: { file: "autobot-inbox/finance" },
      metadata: {},
      actions: [],
    });

    if (statItems.length > 0) {
      sections.unshift({
        id: "todays-numbers",
        title: "Today's Numbers",
        description: "Live operational stats from autobot-inbox",
        items: statItems,
      });
    }
  }

  const agenda: AgendaData = {
    sections,
    specIndex,
    fetchedAt: new Date().toISOString(),
    errors,
  };

  return NextResponse.json({ agenda });
}
