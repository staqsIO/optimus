"use client";

import React from "react";
import type { BoardRole } from "@/hooks/useCurrentUser";

/* ------------------------------------------------------------------ */
/*  Page Registry — single source of truth for all navigable pages    */
/* ------------------------------------------------------------------ */

export interface PageEntry {
  slug: string;
  label: string;
  group: string;
  keywords?: string[];
}

const GROUP_ORDER = ["Pinned", "Control", "Agents", "Data", "System"] as const;

export const PAGE_REGISTRY: PageEntry[] = [
  // Control
  { slug: "chat", label: "Chat", group: "Control", keywords: ["conversation", "ask", "talk", "message"] },
  { slug: "today", label: "Today", group: "Control", keywords: ["dashboard", "home", "daily"] },
  { slug: "calendar", label: "Calendar", group: "Control", keywords: ["calendar", "month", "day", "schedule", "history", "agenda"] },
  { slug: "meetings", label: "Meetings", group: "Control", keywords: ["meeting", "meetings", "voice", "voice memo", "tldv", "tl;dv", "gemini", "meet", "transcript", "recording"] },
  { slug: "drafts", label: "Drafts", group: "Control", keywords: ["email", "compose", "write"] },
  { slug: "content", label: "Content", group: "Control", keywords: ["blog", "linkedin", "post", "publish", "article", "writing"] },
  { slug: "contracts", label: "Contracts", group: "Control", keywords: ["contracts", "proposals", "signing", "signature", "agreement", "sow"] },
  { slug: "artifacts", label: "Artifacts", group: "Control", keywords: ["artifacts", "captured", "enrichment", "links", "facts", "review queue", "provenance", "versions"] },
  { slug: "capture", label: "Capture", group: "Control", keywords: ["drive", "google drive", "shared drive", "folder", "picker", "sync", "capture sources", "watch", "ingest"] },
  { slug: "campaigns", label: "Runs", group: "Control", keywords: ["runs", "executing", "active", "status", "progress", "campaigns"] },
  { slug: "deals", label: "Deals", group: "Control", keywords: ["pipeline", "kanban", "sales", "opportunities", "stage", "won", "lost"] },
  { slug: "engagements", label: "Engagements", group: "Control", keywords: ["proposals", "scoping", "spec", "client project", "rfp", "scope"] },
  { slug: "projects", label: "Projects", group: "Control", keywords: ["folders", "workspace"] },
  { slug: "governance", label: "Governance", group: "Control", keywords: ["policy", "rules", "constitution"] },

  // Agents
  { slug: "agents", label: "Agents", group: "Agents", keywords: ["bots", "workers", "executor"] },
  { slug: "runners", label: "Runners", group: "Agents", keywords: ["host", "machine", "m1", "railway", "heartbeat", "satellite"] },

  // Data
  { slug: "contacts", label: "Contacts", group: "Data", keywords: ["people", "address book"] },
  { slug: "organizations", label: "Organizations", group: "Data", keywords: ["companies", "orgs", "company", "umb", "rentcentives", "sodexis"] },
  { slug: "relationships", label: "Relationships", group: "Data", keywords: ["health", "decaying", "follow up", "ghosted", "silent", "strength"] },
  { slug: "knowledge-base", label: "Knowledge Base", group: "Data", keywords: ["docs", "documents", "rag", "kb"] },
  { slug: "wiki", label: "Wiki", group: "Data", keywords: ["vault", "pages", "markdown", "toc"] },
  { slug: "search", label: "Search", group: "Data", keywords: ["find", "query", "lookup"] },
  { slug: "signals", label: "Signals", group: "Data", keywords: ["briefing", "extraction", "insights"] },
  { slug: "voice", label: "Voice", group: "Data", keywords: ["tone", "writing", "style", "profile", "edits"] },
  { slug: "voice-prints", label: "Voice Prints", group: "Data", keywords: ["voiceprint", "speaker", "enrollment", "eagle", "picovoice", "diarization", "identification"] },

  // System — diagnosis & internals (operator-leaning)
  { slug: "activity", label: "Activity", group: "System", keywords: ["log", "trace", "events", "gate", "failures"] },
  { slug: "observability", label: "Services", group: "System", keywords: ["services", "scheduled", "cron", "jobs", "pause", "resume", "trigger", "uptime", "health", "observability"] },
  { slug: "github", label: "GitHub", group: "System", keywords: ["github", "pr", "pull request", "issue", "code", "merged", "review", "repo"] },
  { slug: "telegram", label: "Telegram", group: "System", keywords: ["telegram", "bot", "chat", "message", "inbound", "outbound", "notification", "comms", "channel"] },
  { slug: "board", label: "Board", group: "System", keywords: ["kanban", "tasks", "flow", "needs you", "blocked", "directive", "workstream"] },
  { slug: "pipeline", label: "Pipeline", group: "System", keywords: ["tasks", "queue", "jobs"] },
  { slug: "flows", label: "Flows", group: "System", keywords: ["workflow", "signal flow"] },
  { slug: "graph", label: "Graph", group: "System", keywords: ["visualization", "dag", "network"] },
  { slug: "architecture", label: "Architecture", group: "System", keywords: ["codebase", "code map", "architecture graph", "understand", "modules", "layers", "dependencies", "knowledge graph", "guided tour"] },
  { slug: "workstation", label: "Workstation", group: "System", keywords: ["ai", "chat", "assistant"] },
  { slug: "spec", label: "Spec", group: "System", keywords: ["architecture", "specification", "design"] },
  { slug: "settings", label: "Settings", group: "System", keywords: ["config", "preferences", "options"] },
];

/* ------------------------------------------------------------------ */
/*  Role → allowed page slugs                                         */
/* ------------------------------------------------------------------ */

export const NAV_BY_ROLE: Record<BoardRole, string[]> = {
  admin: PAGE_REGISTRY.map((p) => p.slug), // superuser — everything
  member: [
    "chat", "today", "calendar", "meetings", "drafts", "content", "contracts", "artifacts", "capture", "campaigns", "deals", "projects", "agents", "runners",
    "contacts", "organizations", "relationships", "knowledge-base", "signals", "voice", "voice-prints", "search",
    "wiki",
    "activity", "observability", "github", "telegram", "board", "pipeline", "flows", "graph", "architecture", "workstation", "spec",
  ],
  external_agent: ["today", "meetings", "projects", "search"],
};

/* ------------------------------------------------------------------ */
/*  Icons — keyed by page slug, extracted from old SideNav inline SVGs */
/* ------------------------------------------------------------------ */

function icon(d: string) {
  return React.createElement(
    "svg",
    { className: "w-4 h-4", fill: "none", stroke: "currentColor", viewBox: "0 0 24 24" },
    React.createElement("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.5, d }),
  );
}

export const NAV_ICONS: Record<string, React.ReactNode> = {
  chat: icon("M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"),
  today: icon("M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"),
  calendar: icon("M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"),
  meetings: icon("M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"),
  drafts: icon("M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"),
  campaigns: icon("M13 10V3L4 14h7v7l9-11h-7z"),
  content: icon("M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"),
  contracts: icon("M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"),
  artifacts: icon("M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"),
  capture: icon("M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2zM12 11v6m0 0l-2-2m2 2l2-2"),
  projects: icon("M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"),
  governance: icon("M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"),
  agents: icon("M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"),
  runners: icon("M5 12V7a2 2 0 012-2h10a2 2 0 012 2v5M5 12h14M5 12v5a2 2 0 002 2h10a2 2 0 002-2v-5M9 9h.01M9 16h.01"),
  contacts: icon("M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"),
  "knowledge-base": icon("M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"),
  wiki: icon("M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"),
  voice: icon("M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"),
  search: icon("M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"),
  signals: icon("M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"),
  pipeline: icon("M3 4h18M3 8h18M3 12h12M3 16h8"),
  board: icon("M4 4h6v16H4zM14 4h6v10h-6z"),
  spec: icon("M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"),
  settings: icon("M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"),
  graph: icon("M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM7 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H9a2 2 0 01-2-2v-2z"),
  flows: icon("M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"),
  architecture: icon("M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"),
  workstation: icon("M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"),
  activity: icon("M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"),
  observability: icon("M13 10V3L4 14h7v7l9-11h-7z"),
  github: icon("M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"),
  telegram: icon("M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"),
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Get pages visible to a role, with pinned pages promoted to a "Pinned" group */
export function getVisiblePages(
  role: BoardRole,
  pinnedSlugs: string[] = [],
): { pinned: PageEntry[]; groups: { title: string; pages: PageEntry[] }[] } {
  const allowed = new Set(NAV_BY_ROLE[role] || NAV_BY_ROLE.member);
  const pinnedSet = new Set(pinnedSlugs);

  const visiblePages = PAGE_REGISTRY.filter((p) => allowed.has(p.slug));
  const pinned = pinnedSlugs
    .map((slug) => visiblePages.find((p) => p.slug === slug))
    .filter((p): p is PageEntry => !!p);

  // Group non-pinned pages by their group field, preserving GROUP_ORDER
  const groupMap = new Map<string, PageEntry[]>();
  for (const p of visiblePages) {
    if (pinnedSet.has(p.slug)) continue; // skip — already in pinned
    const list = groupMap.get(p.group) || [];
    list.push(p);
    groupMap.set(p.group, list);
  }

  const groups = GROUP_ORDER
    .filter((g) => g !== "Pinned" && groupMap.has(g))
    .map((title) => ({ title, pages: groupMap.get(title)! }));

  return { pinned, groups };
}

/** Get all pages a role can access (flat list, for command palette) */
export function getAllowedPages(role: BoardRole): PageEntry[] {
  const allowed = new Set(NAV_BY_ROLE[role] || NAV_BY_ROLE.member);
  return PAGE_REGISTRY.filter((p) => allowed.has(p.slug));
}
