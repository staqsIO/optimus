"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { markdownToHtml } from "@/lib/markdown";
import { opsDelete, opsFetch, opsPatch, opsPost } from "@/lib/ops-api";

/** Sidebar scope: every org + project wiki tree together */
const ALL_PROJECTS = "__ALL__";

type WikiNode = {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  is_index: boolean;
  updated_at: string;
};

type WikiPage = {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  slug: string;
  title: string;
  content: string;
  classification: string;
  is_index: boolean;
  compiled_at: string | null;
  source_document_id: string | null;
  source_updated_at?: string | null;
  needs_update?: boolean;
  updated_at: string;
  /** Present when page belongs to a Linear-backed project */
  project_slug?: string | null;
  project_name?: string | null;
};

type ForestProject = { id: string; slug: string; name: string; nodes: WikiNode[] };
type ForestData = { org_nodes: WikiNode[]; projects: ForestProject[] };

type WikiBacklink = { id: string; slug: string; title: string; project_slug: string | null };

type WikiOutlinkResolved = {
  id: string;
  title: string;
  slug: string;
  project_slug: string | null;
};

type WikiOutlink = { slug: string; label: string; resolved: WikiOutlinkResolved | null };

type SlugCandidate = { id: string; project_slug: string | null; title: string };

type WikiLinkResolve =
  | { kind: "none" }
  | { kind: "unique"; id: string }
  | { kind: "ambiguous"; candidates: SlugCandidate[] };

function flattenForest(f: ForestData): WikiNode[] {
  return [...f.org_nodes, ...f.projects.flatMap((p) => p.nodes)];
}

function buildWikiChildrenMap(nodes: WikiNode[]): Map<string | null, WikiNode[]> {
  const map = new Map<string | null, WikiNode[]>();
  for (const n of nodes) {
    const key = n.parent_id || null;
    const arr = map.get(key) || [];
    arr.push(n);
    map.set(key, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => Number(b.is_index) - Number(a.is_index) || a.title.localeCompare(b.title));
  }
  return map;
}

function buildForestSlugIndex(forest: ForestData): Map<string, SlugCandidate[]> {
  const bySlug = new Map<string, SlugCandidate[]>();
  const push = (n: WikiNode, project_slug: string | null) => {
    const arr = bySlug.get(n.slug) || [];
    arr.push({ id: n.id, project_slug, title: n.title });
    bySlug.set(n.slug, arr);
  };
  for (const n of forest.org_nodes) push(n, null);
  for (const p of forest.projects) {
    for (const n of p.nodes) push(n, p.slug);
  }
  return bySlug;
}

function buildSingleScopeSlugIndex(nodes: WikiNode[], projectSlug: string): Map<string, SlugCandidate[]> {
  const bySlug = new Map<string, SlugCandidate[]>();
  const scope = projectSlug || null;
  for (const n of nodes) {
    const arr = bySlug.get(n.slug) || [];
    arr.push({ id: n.id, project_slug: scope, title: n.title });
    bySlug.set(n.slug, arr);
  }
  return bySlug;
}

function resolveWikiLink(
  normalizedTarget: string,
  fromPage: WikiPage | null,
  bySlug: Map<string, SlugCandidate[]>
): WikiLinkResolve {
  const cands = bySlug.get(normalizedTarget);
  if (!cands?.length) return { kind: "none" };
  if (cands.length === 1) return { kind: "unique", id: cands[0].id };
  const fromPs = fromPage?.project_slug ?? null;
  const sameScope = cands.filter((c) => (c.project_slug || null) === (fromPs || null));
  if (sameScope.length === 1) return { kind: "unique", id: sameScope[0].id };
  if (sameScope.length > 1) return { kind: "ambiguous", candidates: sameScope };
  const orgOnly = cands.filter((c) => !c.project_slug);
  if (orgOnly.length === 1) return { kind: "unique", id: orgOnly[0].id };
  if (orgOnly.length > 1) return { kind: "ambiguous", candidates: orgOnly };
  if (cands.length > 1) return { kind: "ambiguous", candidates: cands };
  return { kind: "unique", id: cands[0].id };
}

type ProjectOpt = { slug: string; name: string };
type WikiRevision = {
  id: string;
  wiki_page_id: string;
  version: number;
  title: string;
  content: string;
  classification: string;
  parent_id: string | null;
  changed_by: string;
  change_type: "create" | "update";
  created_at: string;
};

type WikiLinkedTask = {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
};

type WikiSignalSummary = {
  tags: string[];
  confidence: string | null;
  actionability: string | null;
  rationale: string | null;
};

type ResearchSource = {
  id: string;
  source_mode?: "url_watch" | "topic_search";
  topic_query?: string | null;
  project_slug?: string | null;
  project_name?: string | null;
  url: string;
  title: string | null;
  tags: string[] | null;
  is_active: boolean;
  poll_interval_ms?: number;
  max_items_per_poll: number;
  last_success_at: string | null;
  last_polled_at?: string | null;
  last_error: string | null;
};

type ResearchPollSummary = {
  ingested: number;
  scanned: number;
  skipped: number;
  errors: number;
  deferred?: number;
  subscriptions?: number;
  wiki_compiled?: number;
  wiki_compile_error?: string;
};

type SourceNotice = { kind: "ok" | "err"; text: string };

function wikiSearchString(scope: string, pageId: string | null): string {
  const p = new URLSearchParams();
  if (scope === ALL_PROJECTS) p.set("scope", "all");
  else if (scope) p.set("project", scope);
  if (pageId) p.set("id", pageId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function WikiVaultContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const ignoreUrlSyncRef = useRef(0);
  const projectSlugRef = useRef("");

  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [projectSlug, setProjectSlug] = useState<string>("");
  const [search, setSearch] = useState("");
  const [nodes, setNodes] = useState<WikiNode[]>([]);
  const [forest, setForest] = useState<ForestData | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [pageSignal, setPageSignal] = useState<WikiSignalSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<WikiRevision[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [restoreCandidate, setRestoreCandidate] = useState<WikiRevision | null>(null);
  const [backlinks, setBacklinks] = useState<WikiBacklink[]>([]);
  const [loadingBacklinks, setLoadingBacklinks] = useState(false);
  const [outlinks, setOutlinks] = useState<WikiOutlink[]>([]);
  const [loadingOutlinks, setLoadingOutlinks] = useState(false);
  const [linkedTasks, setLinkedTasks] = useState<WikiLinkedTask[]>([]);
  const [loadingLinkedTasks, setLoadingLinkedTasks] = useState(false);
  const [wikilinkPick, setWikilinkPick] = useState<{ label: string; candidates: SlugCandidate[] } | null>(null);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceNotice, setSourceNotice] = useState<SourceNotice | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceWebQuery, setSourceWebQuery] = useState("");
  const [sourceProject, setSourceProject] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [sourceIntervalHours, setSourceIntervalHours] = useState("24");
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteTo, setPromoteTo] = useState("architect");
  const [promoteMsg, setPromoteMsg] = useState<string | null>(null);

  const isForestMode = projectSlug === ALL_PROJECTS;

  const writeWikiUrl = useCallback(
    (scope: string, pageId: string | null) => {
      ignoreUrlSyncRef.current += 1;
      router.replace(`${pathname}${wikiSearchString(scope, pageId)}`, { scroll: false });
    },
    [pathname, router]
  );

  function selectWikiPage(id: string) {
    setSelectedId(id);
    writeWikiUrl(projectSlugRef.current, id);
  }

  function applyWikiScope(nextScope: string) {
    router.replace(`${pathname}${wikiSearchString(nextScope, null)}`, { scroll: false });
  }

  function sectionExpanded(key: string) {
    if (expandedSections[key] !== undefined) return expandedSections[key];
    return key === "org";
  }

  function toggleSection(key: string) {
    setExpandedSections((s) => ({ ...s, [key]: !sectionExpanded(key) }));
  }

  /** Reload sidebar data without changing scope; keeps selection unless caller adjusts it. */
  async function refreshTree(): Promise<WikiNode[]> {
    if (projectSlug === ALL_PROJECTS) {
      const data = await opsFetch<ForestData>("/api/wiki/forest");
      const fd = data || { org_nodes: [], projects: [] };
      setForest(fd);
      const flat = flattenForest(fd);
      setNodes(flat);
      return flat;
    }
    setForest(null);
    const path = `/api/wiki/tree${projectSlug ? `?project_slug=${encodeURIComponent(projectSlug)}` : ""}`;
    const treedata = await opsFetch<{ nodes: WikiNode[] }>(path);
    const next = treedata?.nodes || [];
    setNodes(next);
    return next;
  }

  function formatIsoUtc(value: string) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace("T", " ").replace(".000Z", " UTC");
  }

  async function loadPage(id: string) {
    const path = `/api/wiki/page?id=${encodeURIComponent(id)}`;
    const data = await opsFetch<{ page: WikiPage; signal?: WikiSignalSummary | null }>(path);
    setPage(data?.page || null);
    setPageSignal(data?.signal ?? null);
    setEditing(false);
    setDraft(data?.page?.content || "");
  }

  async function loadRevisions(id: string) {
    setLoadingRevisions(true);
    const data = await opsFetch<{ revisions: WikiRevision[] }>(`/api/wiki/page/revisions?id=${encodeURIComponent(id)}`);
    setRevisions(data?.revisions || []);
    setLoadingRevisions(false);
  }

  useEffect(() => {
    projectSlugRef.current = projectSlug;
  }, [projectSlug]);

  useEffect(() => {
    opsFetch<{ projects: ProjectOpt[] }>("/api/projects")
      .then((d) => setProjects((d?.projects || []).map((p) => ({ slug: p.slug, name: p.name }))));
    void opsFetch<{ subscriptions: ResearchSource[] }>("/api/research-sources/subscriptions")
      .then((d) => setSources(d?.subscriptions || []));
  }, []);

  useEffect(() => {
    if (ignoreUrlSyncRef.current > 0) {
      ignoreUrlSyncRef.current -= 1;
      return;
    }

    void (async () => {
      const id = searchParams.get("id");
      const slug = searchParams.get("slug");
      const scope = searchParams.get("scope");
      const project = searchParams.get("project");

      let nextScope = "";
      let pendingId: string | null = null;

      if (id) {
        const data = await opsFetch<{ page: WikiPage }>(`/api/wiki/page?id=${encodeURIComponent(id)}`);
        const p = data?.page;
        if (p) {
          nextScope = scope === "all" ? ALL_PROJECTS : p.project_slug || "";
          pendingId = id;
        } else if (scope === "all") nextScope = ALL_PROJECTS;
        else if (project) nextScope = project;
        else nextScope = "";
      } else if (slug) {
        const sp = new URLSearchParams({ slug });
        if (project) sp.set("project_slug", project);
        const data = await opsFetch<{ page: WikiPage }>(`/api/wiki/page?${sp.toString()}`);
        const p = data?.page;
        if (p) {
          nextScope = scope === "all" ? ALL_PROJECTS : p.project_slug || project || "";
          pendingId = p.id;
        } else if (scope === "all") nextScope = ALL_PROJECTS;
        else if (project) nextScope = project;
        else nextScope = "";
      } else {
        if (scope === "all") nextScope = ALL_PROJECTS;
        else if (project) nextScope = project;
        else nextScope = "";
      }

      setProjectSlug(nextScope);

      let flat: WikiNode[] = [];
      if (nextScope === ALL_PROJECTS) {
        const data = await opsFetch<ForestData>("/api/wiki/forest");
        const fd = data || { org_nodes: [], projects: [] };
        setForest(fd);
        flat = flattenForest(fd);
      } else {
        setForest(null);
        const path = `/api/wiki/tree${nextScope ? `?project_slug=${encodeURIComponent(nextScope)}` : ""}`;
        const treedata = await opsFetch<{ nodes: WikiNode[] }>(path);
        flat = treedata?.nodes || [];
      }
      setNodes(flat);

      const sel = pendingId || flat[0]?.id || null;
      setSelectedId(sel);

      const wantQs = wikiSearchString(nextScope, sel);
      const curQs = typeof window !== "undefined" ? window.location.search || "" : "";
      if (wantQs !== curQs) {
        writeWikiUrl(nextScope, sel);
      }
    })();
  }, [searchParams, writeWikiUrl]);

  useEffect(() => {
    if (selectedId) {
      void loadPage(selectedId);
      void loadRevisions(selectedId);
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setBacklinks([]);
      return;
    }
    setLoadingBacklinks(true);
    void opsFetch<{ backlinks: WikiBacklink[] }>(`/api/wiki/page/backlinks?id=${encodeURIComponent(selectedId)}`)
      .then((d) => setBacklinks(d?.backlinks || []))
      .finally(() => setLoadingBacklinks(false));
  }, [selectedId]);

  useEffect(() => {
    if (!page?.id) {
      setOutlinks([]);
      return;
    }
    setLoadingOutlinks(true);
    void opsFetch<{ outlinks: WikiOutlink[] }>(`/api/wiki/page/outlinks?id=${encodeURIComponent(page.id)}`)
      .then((d) => setOutlinks(d?.outlinks || []))
      .finally(() => setLoadingOutlinks(false));
  }, [page?.id]);

  useEffect(() => {
    if (!page?.id) {
      setLinkedTasks([]);
      return;
    }
    setLoadingLinkedTasks(true);
    void opsFetch<{ tasks: WikiLinkedTask[] }>(`/api/wiki/page/tasks?id=${encodeURIComponent(page.id)}`)
      .then((d) => setLinkedTasks(d?.tasks || []))
      .finally(() => setLoadingLinkedTasks(false));
  }, [page?.id, promoteMsg]);

  const filteredNodes = useMemo(() => {
    if (!search.trim()) return nodes;
    const q = search.toLowerCase();
    return nodes.filter((n) => n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q));
  }, [nodes, search]);

  const childrenByParent = useMemo(() => buildWikiChildrenMap(filteredNodes), [filteredNodes]);

  const forestSections = useMemo(() => {
    if (!isForestMode || !forest) return null;
    const q = search.trim().toLowerCase();
    const filt = (arr: WikiNode[]) =>
      !q ? arr : arr.filter((n) => n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q));
    return [
      { key: "org", label: "Organization", nodes: filt(forest.org_nodes) },
      ...forest.projects.map((p) => ({ key: p.slug, label: p.name, nodes: filt(p.nodes) })),
    ];
  }, [isForestMode, forest, search]);

  const slugIndex = useMemo(() => {
    if (isForestMode && forest) return buildForestSlugIndex(forest);
    return buildSingleScopeSlugIndex(nodes, projectSlug === ALL_PROJECTS ? "" : projectSlug);
  }, [isForestMode, forest, nodes, projectSlug]);

  async function saveEdit() {
    if (!page) return;
    setSaving(true);
    const result = await opsPatch<{ page: WikiPage }>("/api/wiki/page", {
      id: page.id,
      content: draft,
      compiled_at: null,
    });
    setSaving(false);
    if (result.ok) {
      setEditing(false);
      await loadPage(page.id);
      await loadRevisions(page.id);
      await refreshTree();
    }
  }

  async function createChildPage() {
    if (!page) return;
    const slug = prompt("New page slug (e.g. architecture-notes):");
    if (!slug) return;
    const title = prompt("Page title:", slug);
    if (!title) return;
    const effectiveProjectSlug =
      projectSlug === ALL_PROJECTS ? page.project_slug || undefined : projectSlug || undefined;
    const res = await opsPost<{ page: WikiPage }>("/api/wiki/page", {
      project_slug: effectiveProjectSlug,
      parent_id: page.id,
      slug,
      title,
      content: `# ${title}\n\n`,
      is_index: false,
    });
    if (res.ok) {
      await refreshTree();
      selectWikiPage(res.data.page.id);
    }
  }

  async function restoreRevision(rev: WikiRevision) {
    if (!page) return;
    setSaving(true);
    const result = await opsPatch<{ page: WikiPage }>("/api/wiki/page", {
      id: page.id,
      title: rev.title,
      content: rev.content,
      classification: rev.classification,
      parent_id: rev.parent_id,
      compiled_at: null,
    });
    setSaving(false);
    if (result.ok) {
      await loadPage(page.id);
      await loadRevisions(page.id);
      await refreshTree();
    }
  }

  async function deleteCurrentPage() {
    if (!page) return;
    const ok = confirm(`Delete wiki page "${page.title}"? This cannot be undone.`);
    if (!ok) return;
    const res = await opsDelete<{ ok: boolean; deleted_id: string }>(`/api/wiki/page?id=${encodeURIComponent(page.id)}`);
    if (!res.ok) return;
    const deletedId = page.id;
    setPage(null);
    setPageSignal(null);
    setRevisions([]);
    const flat = await refreshTree();
    const remaining = flat.filter((n) => n.id !== deletedId);
    const nextId = remaining[0]?.id ?? null;
    setSelectedId(nextId);
    writeWikiUrl(projectSlugRef.current, nextId);
  }

  function simpleLineDiff(current: string, incoming: string) {
    const a = current.split("\n");
    const b = incoming.split("\n");
    const max = Math.max(a.length, b.length);
    const rows: Array<{ type: "same" | "remove" | "add"; left?: string; right?: string }> = [];
    for (let i = 0; i < max; i++) {
      const left = a[i];
      const right = b[i];
      if (left === right) {
        if (left !== undefined) rows.push({ type: "same", left, right });
      } else {
        if (left !== undefined) rows.push({ type: "remove", left });
        if (right !== undefined) rows.push({ type: "add", right });
      }
    }
    return rows;
  }

  function normalizeWikiSlug(input: string) {
    return String(input || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120);
  }

  function relTime(value?: string | null) {
    if (!value) return "never";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "unknown";
    const ms = Date.now() - d.getTime();
    if (ms < 60_000) return "just now";
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  async function refreshSources() {
    const d = await opsFetch<{ subscriptions: ResearchSource[] }>("/api/research-sources/subscriptions");
    setSources(d?.subscriptions || []);
  }

  async function addSource() {
    if (!sourceUrl.trim()) return;
    setSourceBusy(true);
    setSourceNotice(null);
    const tags = sourceTags.split(",").map((t) => t.trim()).filter(Boolean);
    const intervalMs = Math.max(1, Number(sourceIntervalHours) || 24) * 60 * 60 * 1000;
    const res = await opsPost<{ subscription: ResearchSource }>("/api/research-sources/subscriptions", {
      source_mode: "url_watch",
      url: sourceUrl.trim(),
      topic_query: sourceWebQuery.trim() || undefined,
      title: sourceTitle.trim() || undefined,
      project_slug: sourceProject || undefined,
      tags,
      poll_interval_ms: intervalMs,
      max_items_per_poll: 20,
    });
    if (!res.ok) {
      setSourceNotice({ kind: "err", text: res.error || "Failed to save source" });
      setSourceBusy(false);
      return;
    }
    setSourceNotice({ kind: "ok", text: "Source saved." });
    setSourceUrl("");
    setSourceTitle("");
    setSourceWebQuery("");
    setSourceTags("");
    await refreshSources();
    setSourceBusy(false);
  }

  async function pollSource(id?: string) {
    setSourceBusy(true);
    setSourceNotice(null);
    const res = await opsPost<ResearchPollSummary>("/api/research-sources/poll", {
      id,
      max_items: 20,
      auto_compile_wiki: true,
    });
    if (!res.ok) {
      setSourceNotice({ kind: "err", text: res.error || "Poll failed" });
      setSourceBusy(false);
      return;
    }
    const d = res.data;
    const def = typeof d.deferred === "number" && d.deferred > 0 ? `, ${d.deferred} not due yet` : "";
    let compileHint = "";
    if (d.ingested > 0) {
      if (typeof d.wiki_compiled === "number" && d.wiki_compiled > 0) {
        compileHint = ` Wiki auto-compile: ${d.wiki_compiled} article(s).`;
      } else if (d.wiki_compile_error) {
        compileHint = ` Wiki auto-compile failed (${d.wiki_compile_error}).`;
      } else if (typeof d.wiki_compiled === "number") {
        compileHint = " Wiki auto-compile returned 0 articles (gates, limits, or nothing in this scope).";
      } else {
        compileHint = " Documents queued for the compiler.";
      }
    }
    setSourceNotice({
      kind: d.errors > 0 || !!d.wiki_compile_error ? "err" : "ok",
      text: `Poll: ${d.ingested} ingested · ${d.scanned} scanned · ${d.skipped} skipped · ${d.errors} errors${def}.${compileHint}`,
    });
    await refreshSources();
    if (typeof d.wiki_compiled === "number" && d.wiki_compiled > 0) {
      await refreshTree();
    }
    setSourceBusy(false);
  }

  async function toggleSource(id: string, active: boolean) {
    setSourceBusy(true);
    const prev = sources;
    setSources((arr) => arr.map((s) => (s.id === id ? { ...s, is_active: active } : s)));
    const res = await opsPatch<{ subscription: ResearchSource }>("/api/research-sources/subscriptions", { id, is_active: active });
    if (!res.ok) {
      setSources(prev);
      setSourceNotice({ kind: "err", text: res.error || "Failed to update source" });
    } else {
      await refreshSources();
    }
    setSourceBusy(false);
  }

  async function deleteSource(id: string) {
    if (sourceBusy) return;
    const ok = typeof window === "undefined" ? true : window.confirm("Delete this source?");
    if (!ok) return;
    setSourceBusy(true);
    const prev = sources;
    setSources((arr) => arr.filter((s) => s.id !== id));
    const res = await opsDelete<{ ok: boolean; id: string }>(
      `/api/research-sources/subscriptions?id=${encodeURIComponent(id)}`
    );
    if (!res.ok) {
      setSources(prev);
      setSourceNotice({ kind: "err", text: res.error || "Failed to delete source" });
    } else {
      setSourceNotice({ kind: "ok", text: "Source deleted." });
      await refreshSources();
    }
    setSourceBusy(false);
  }

  async function promoteCurrentPage() {
    if (!page) return;
    setPromoteBusy(true);
    setPromoteMsg(null);
    const res = await opsPost<{ ok: boolean; work_item_id: string; assigned_to: string }>("/api/wiki/page/promote", {
      id: page.id,
      assigned_to: promoteTo,
    });
    if (!res.ok) {
      setPromoteMsg(res.error || "Failed to create task");
      setPromoteBusy(false);
      return;
    }
    setPromoteMsg(`Created task ${res.data.work_item_id} (${res.data.assigned_to}).`);
    setPromoteBusy(false);
  }

  function renderWikiMarkdown(md: string) {
    // Convert Obsidian-style wikilinks into clickable anchors for in-app navigation.
    const withWikiAnchors = md.replace(/\[\[([^[\]]+)\]\]/g, (_full, inner: string) => {
      const [targetRaw, labelRaw] = inner.split("|");
      const target = normalizeWikiSlug(targetRaw || "");
      const label = (labelRaw || targetRaw || "").trim();
      if (!target) return label;
      return `<a href="#wiki:${target}" data-wiki-slug="${target}">${label}</a>`;
    });
    return markdownToHtml(withWikiAnchors);
  }

  function renderNodeBranch(
    cmap: Map<string | null, WikiNode[]>,
    parentId: string | null,
    depth: number
  ): ReactElement[] {
    const list = cmap.get(parentId) || [];
    return list.flatMap((n) => {
      const isActive = n.id === selectedId;
      return [
        <button
          key={n.id}
          type="button"
          onClick={() => selectWikiPage(n.id)}
          className={`w-full text-left px-2.5 py-2 rounded-md text-sm transition-colors ${
            isActive ? "bg-zinc-800/90 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900/80 hover:text-zinc-200"
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {n.is_index ? "▸ " : ""}{n.title}
        </button>,
        ...renderNodeBranch(cmap, n.id, depth + 1),
      ];
    });
  }

  function renderResearchIngestPanel() {
    return (
      <div className="px-3 pt-3 pb-2 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Page ingest</h2>
            <p className="text-[11px] text-zinc-600 mt-0.5 leading-snug">
              Watch a URL and optionally add a web search line each poll. Compiles into wiki pages via the button below.
            </p>
          </div>
          <button
            type="button"
            onClick={() => pollSource()}
            disabled={sourceBusy}
            className="shrink-0 text-[11px] font-medium text-blue-300 hover:text-blue-200 disabled:opacity-40"
          >
            Poll all
          </button>
        </div>

        <div className="rounded-lg border border-white/10 bg-zinc-900/60 p-2.5 space-y-2">
          <p className="text-[10px] text-zinc-600 leading-snug">
            Uses the same scope as the wiki tree (left). Ingestion auto-compiles with scheduler/API when enabled:{" "}
            <code className="text-zinc-500">WIKI_AUTO_COMPILE_AFTER_RESEARCH_POLL=1</code> on the API.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border border-white/10 bg-zinc-900/40 p-2.5">
          <label htmlFor="wiki-rs-url" className="text-[10px] font-medium text-zinc-500">
            Page URL
          </label>
          <input
            id="wiki-rs-url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://example.com/docs"
            className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
          />

          <label htmlFor="wiki-rs-title" className="text-[10px] font-medium text-zinc-500">
            Label (optional)
          </label>
          <input
            id="wiki-rs-title"
            value={sourceTitle}
            onChange={(e) => setSourceTitle(e.target.value)}
            placeholder="Short name for this source"
            className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
          />

          <label htmlFor="wiki-rs-web" className="text-[10px] font-medium text-zinc-500">
            Web search (optional)
          </label>
          <input
            id="wiki-rs-web"
            value={sourceWebQuery}
            onChange={(e) => setSourceWebQuery(e.target.value)}
            placeholder="Extra lines to ingest each poll"
            className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
          />

          <label htmlFor="wiki-rs-project" className="text-[10px] font-medium text-zinc-500">
            Visibility
          </label>
          <select
            id="wiki-rs-project"
            value={sourceProject}
            onChange={(e) => setSourceProject(e.target.value)}
            className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200"
          >
            <option value="">Org-wide</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>

          <label htmlFor="wiki-rs-tags" className="text-[10px] font-medium text-zinc-500">
            Tags
          </label>
          <input
            id="wiki-rs-tags"
            value={sourceTags}
            onChange={(e) => setSourceTags(e.target.value)}
            placeholder="comma-separated"
            className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
          />

          <label htmlFor="wiki-rs-interval" className="text-[10px] font-medium text-zinc-500">
            Poll every (hours)
          </label>
          <input
            id="wiki-rs-interval"
            type="number"
            min={1}
            step={1}
            value={sourceIntervalHours}
            onChange={(e) => setSourceIntervalHours(e.target.value)}
            className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200"
          />

          <button
            type="button"
            onClick={addSource}
            disabled={sourceBusy || !sourceUrl.trim()}
            className="w-full text-xs font-medium px-2 py-2 rounded-md bg-emerald-600/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-40"
          >
            Add source
          </button>
          {sourceNotice ? (
            <div
              className={`text-[11px] leading-snug rounded-md px-2 py-1.5 ${
                sourceNotice.kind === "err"
                  ? "bg-red-950/40 text-red-200/90 border border-red-500/20"
                  : "bg-zinc-800/80 text-zinc-300 border border-white/5"
              }`}
            >
              {sourceNotice.text}
            </div>
          ) : null}
        </div>

        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 mb-1.5">Sources</div>
          <div className="space-y-2 max-h-52 overflow-y-auto pr-0.5">
            {sources.map((s) => (
              <div key={s.id} className="rounded-md border border-white/8 bg-zinc-950/40 p-2">
                <div className="text-xs font-medium text-zinc-200 truncate">
                  {s.source_mode === "topic_search"
                    ? (s.topic_query || s.title || "Web search only")
                    : (s.title || s.url)}
                </div>
                {s.url ? <div className="text-[10px] text-zinc-500 truncate mt-0.5">{s.url}</div> : null}
                {s.source_mode === "url_watch" && s.topic_query ? (
                  <div className="text-[10px] text-zinc-500 mt-0.5 truncate" title={s.topic_query}>
                    + web: {s.topic_query}
                  </div>
                ) : null}
                <div className="text-[10px] text-zinc-500 mt-1.5 leading-relaxed">
                  {(s.project_name || s.project_slug || "org")} ·{" "}
                  {s.source_mode === "topic_search" ? "web-only" : s.topic_query ? "page + web" : "page"} · every{" "}
                  {Math.max(1, Math.round((Number(s.poll_interval_ms) || 3_600_000) / 3_600_000))}
                  h · last ingest {relTime(s.last_success_at)} · polled {relTime(s.last_polled_at)}
                </div>
                {s.last_error ? (
                  <div className="text-[10px] text-amber-200/90 bg-amber-950/35 border border-amber-500/20 rounded px-1.5 py-1 mt-1.5 leading-snug">
                    {s.last_error}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                  <label className="inline-flex items-center gap-1.5 text-zinc-400">
                    <input
                      type="checkbox"
                      checked={!!s.is_active}
                      onChange={(e) => toggleSource(s.id, e.target.checked)}
                      disabled={sourceBusy}
                      className="rounded border-zinc-600"
                    />
                    active
                  </label>
                  <button
                    type="button"
                    onClick={() => pollSource(s.id)}
                    disabled={sourceBusy}
                    className="text-blue-300 hover:text-blue-200 disabled:opacity-40 font-medium"
                  >
                    Poll
                  </button>
                  <button
                    type="button"
                    onClick={() => applyWikiScope(s.project_slug || "")}
                    className="text-blue-300/90 hover:text-blue-200 font-medium"
                    title={s.project_slug ? `Scope wiki to ${s.project_slug}` : "Scope wiki to organization pages"}
                  >
                    Open in wiki scope
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSource(s.id)}
                    disabled={sourceBusy}
                    className="text-red-300/90 hover:text-red-200 disabled:opacity-40 font-medium"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {sources.length === 0 ? <div className="text-[11px] text-zinc-600 py-1">No sources yet.</div> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col lg:grid lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:grid-rows-1">
      <aside className="flex flex-col min-h-0 max-h-[min(52vh,480px)] lg:max-h-none border-b lg:border-b-0 lg:border-r border-white/5 bg-zinc-950/50">
        <header className="shrink-0 px-3 py-2.5 border-b border-white/5">
          <h1 className="text-sm font-semibold text-zinc-100 tracking-tight">Wiki</h1>
          <p className="text-[11px] text-zinc-600 mt-0.5">Pages only — use the ingest column for sources.</p>
        </header>
        <div className="shrink-0 p-3 space-y-2 border-b border-white/5">
          <select
            value={projectSlug}
            onChange={(e) => applyWikiScope(e.target.value)}
            className="w-full bg-zinc-900 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200"
          >
            <option value={ALL_PROJECTS}>All projects</option>
            <option value="">Org-wide only</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter pages…"
            className="w-full bg-zinc-900 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
          {isForestMode && forestSections ? (
            forestSections.map((sec) => {
              const cmap = buildWikiChildrenMap(sec.nodes);
              const open = sectionExpanded(sec.key);
              const count = sec.nodes.length;
              return (
                <div key={sec.key} className="rounded border border-white/5 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleSection(sec.key)}
                    className="w-full flex items-center gap-2 px-2 py-2 text-left text-xs font-semibold text-zinc-400 hover:bg-zinc-900/80"
                  >
                    <span className="text-zinc-600 w-3 shrink-0">{open ? "▼" : "▶"}</span>
                    <span className="truncate">{sec.label}</span>
                    <span className="text-zinc-600 font-normal ml-auto shrink-0">{count}</span>
                  </button>
                  {open ? (
                    <div className="px-0.5 pb-1 space-y-0.5">
                      {count === 0 ? (
                        <div className="px-2 py-2 text-xs text-zinc-600">No pages in this tree.</div>
                      ) : (
                        renderNodeBranch(cmap, null, 0)
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <>
              {renderNodeBranch(childrenByParent, null, 0)}
              {filteredNodes.length === 0 ? (
                <div className="px-2 py-2 text-xs text-zinc-600">
                  No pages in this scope yet.
                </div>
              ) : null}
            </>
          )}
          {isForestMode && forestSections && forestSections.every((s) => s.nodes.length === 0) ? (
            <div className="px-2 py-2 text-xs text-zinc-600">
              {search.trim() ? "No pages match this filter." : "No pages in any tree yet."}
            </div>
          ) : null}
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex flex-col bg-zinc-950/25">
        {!page ? (
          <div className="flex-1 flex flex-col lg:flex-row min-h-0 min-w-0">
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center min-h-[10rem]">
              <p className="text-sm font-medium text-zinc-400">Select a wiki page</p>
              <p className="text-xs text-zinc-600 mt-2 max-w-sm leading-relaxed">
                Use the tree on the left. Page ingest and compile live in the right column on large screens, or scroll
                down on your phone.
              </p>
            </div>
            <div className="shrink-0 border-t lg:border-t-0 lg:border-l border-white/5 lg:w-[min(100%,400px)] max-h-[min(60vh,520px)] lg:max-h-none overflow-y-auto">
              {renderResearchIngestPanel()}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col lg:flex-row min-h-0 min-w-0 overflow-hidden">
            <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4 sm:p-6">
              <div className="max-w-3xl mx-auto">
              <div className="text-xs text-zinc-500 mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-zinc-400">
                  {page.project_slug ? (page.project_name || page.project_slug) : "Organization"}
                </span>
                <span className="text-zinc-600">/</span>
                <code className="text-[10px] text-zinc-600">{page.slug}</code>
                {isForestMode ? <span className="text-zinc-600">· all projects</span> : null}
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h2 className="text-lg sm:text-xl font-semibold text-zinc-100 leading-snug">{page.title}</h2>
                {page.needs_update && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
                    Needs update
                  </span>
                )}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-white/10 shrink-0">
                  {page.classification}
                </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <select
                    value={promoteTo}
                    onChange={(e) => setPromoteTo(e.target.value)}
                    className="bg-zinc-900 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-300"
                    title="Assign promoted task to"
                  >
                    <option value="architect">architect</option>
                    <option value="reviewer">reviewer</option>
                    <option value="executor-research">executor-research</option>
                    <option value="orchestrator">orchestrator</option>
                  </select>
                  <button
                    onClick={promoteCurrentPage}
                    disabled={promoteBusy}
                    className="text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
                  >
                    {promoteBusy ? "Promoting..." : "Promote to task"}
                  </button>
                  <button onClick={createChildPage} className="text-xs text-zinc-400 hover:text-zinc-200">Add child</button>
                  <button onClick={() => setEditing((v) => !v)} className="text-xs text-zinc-400 hover:text-zinc-200">
                    {editing ? "Preview" : "Edit"}
                  </button>
                  <button onClick={deleteCurrentPage} className="text-xs text-red-400 hover:text-red-300">
                    Delete
                  </button>
                  {editing && (
                    <button onClick={saveEdit} disabled={saving} className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50">
                      {saving ? "Saving..." : "Save"}
                    </button>
                  )}
                </div>
              </div>
              {pageSignal &&
              (pageSignal.tags.length > 0 ||
                pageSignal.confidence ||
                pageSignal.actionability ||
                pageSignal.rationale) ? (
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {pageSignal.tags.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-200 border border-indigo-500/25"
                    >
                      {t}
                    </span>
                  ))}
                  {pageSignal.confidence ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-white/10">
                      confidence {pageSignal.confidence}
                    </span>
                  ) : null}
                  {pageSignal.actionability ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-200 border border-emerald-500/25">
                      {pageSignal.actionability}
                    </span>
                  ) : null}
                  <Link
                    href="/today"
                    className="text-[10px] text-blue-300/80 hover:text-blue-200 ml-auto"
                  >
                    Today
                  </Link>
                </div>
              ) : null}
              {editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full min-h-[60vh] bg-zinc-900 border border-white/10 rounded p-3 text-sm text-zinc-200 font-mono"
                />
              ) : (
                <article
                  className="prose prose-invert max-w-none prose-headings:text-zinc-200 prose-p:text-zinc-300"
                  onClick={(e) => {
                    const el = (e.target as HTMLElement).closest("a[data-wiki-slug]") as HTMLAnchorElement | null;
                    if (!el) return;
                    e.preventDefault();
                    const slug = el.getAttribute("data-wiki-slug");
                    if (!slug) return;
                    const hit = resolveWikiLink(slug, page, slugIndex);
                    if (hit.kind === "unique") selectWikiPage(hit.id);
                    else if (hit.kind === "ambiguous")
                      setWikilinkPick({ label: slug, candidates: hit.candidates });
                  }}
                  dangerouslySetInnerHTML={{ __html: renderWikiMarkdown(page.content) }}
                />
              )}
              {promoteMsg ? <div className="mt-2 text-xs text-zinc-500">{promoteMsg}</div> : null}
              </div>
            </div>
            <aside className="w-full lg:w-[min(100%,22rem)] xl:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-white/5 bg-zinc-950/70 flex flex-col min-h-0 max-h-[min(55vh,560px)] lg:max-h-none">
              <div className="overflow-y-auto flex-1 min-h-0 flex flex-col">
                {renderResearchIngestPanel()}
                <div className="border-t border-white/5 p-4 space-y-5">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Outgoing links</h3>
                {loadingOutlinks ? (
                  <div className="text-xs text-zinc-500">Loading…</div>
                ) : outlinks.length === 0 ? (
                  <div className="text-xs text-zinc-600">No wikilinks in this page.</div>
                ) : (
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {outlinks.map((o) => (
                      <li key={o.slug}>
                        {o.resolved ? (
                          <button
                            type="button"
                            onClick={() => selectWikiPage(o.resolved!.id)}
                            className="text-left w-full text-xs text-blue-300/90 hover:text-blue-200 truncate"
                          >
                            {o.resolved.title}
                            {o.resolved.project_slug ? (
                              <span className="block text-[10px] text-zinc-600">{o.resolved.project_slug}</span>
                            ) : (
                              <span className="block text-[10px] text-zinc-600">org</span>
                            )}
                          </button>
                        ) : (
                          <span className="text-xs text-zinc-500" title={`Unresolved: ${o.label}`}>
                            {o.label}
                            <span className="block text-[10px] text-zinc-600">no page · {o.slug}</span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Backlinks</h3>
                {loadingBacklinks ? (
                  <div className="text-xs text-zinc-500">Loading…</div>
                ) : backlinks.length === 0 ? (
                  <div className="text-xs text-zinc-600">No incoming wikilinks.</div>
                ) : (
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {backlinks.map((b) => (
                      <li key={b.id}>
                        <button
                          type="button"
                          onClick={() => selectWikiPage(b.id)}
                          className="text-left w-full text-xs text-blue-300/90 hover:text-blue-200 truncate"
                        >
                          {b.title}
                          {b.project_slug ? (
                            <span className="block text-[10px] text-zinc-600">{b.project_slug}</span>
                          ) : (
                            <span className="block text-[10px] text-zinc-600">org</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Linked tasks</h3>
                {loadingLinkedTasks ? (
                  <div className="text-xs text-zinc-500">Loading…</div>
                ) : linkedTasks.length === 0 ? (
                  <div className="text-xs text-zinc-600">No tasks linked yet.</div>
                ) : (
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {linkedTasks.map((t) => (
                      <li key={t.id} className="text-xs">
                        <Link
                          href={`/pipeline?task=${encodeURIComponent(t.id)}`}
                          className="text-zinc-300 truncate block hover:text-blue-200"
                          title={t.title}
                        >
                          {t.title}
                        </Link>
                        <div className="text-[10px] text-zinc-600 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span>
                            {t.status} · {t.assigned_to || "unassigned"} · p{t.priority}
                          </span>
                          <Link
                            href={`/pipeline?task=${encodeURIComponent(t.id)}`}
                            className="text-blue-300/80 hover:text-blue-200"
                          >
                            Pipeline
                          </Link>
                          <Link
                            href={`/activity?task=${encodeURIComponent(t.id)}`}
                            className="text-blue-300/80 hover:text-blue-200"
                          >
                            Activity
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Revisions</h3>
              {loadingRevisions ? (
                <div className="text-xs text-zinc-500">Loading…</div>
              ) : revisions.length === 0 ? (
                <div className="text-xs text-zinc-600">No revisions yet.</div>
              ) : (
                <div className="space-y-2 max-h-56 lg:max-h-64 overflow-y-auto">
                  {revisions.map((r, idx) => (
                    <div key={r.id} className="border border-white/5 rounded p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-zinc-300">v{r.version}</span>
                        {idx === 0 && <span className="text-[10px] text-emerald-400">latest</span>}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-1">
                        {r.change_type} by {r.changed_by}
                      </div>
                      <div className="text-[10px] text-zinc-600">
                        {formatIsoUtc(r.created_at)}
                      </div>
                      <button
                        onClick={() => setRestoreCandidate(r)}
                        disabled={saving || idx === 0}
                        className="mt-2 text-[10px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                      >
                        Restore this version
                      </button>
                    </div>
                  ))}
                </div>
              )}
              </div>
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>
      {wikilinkPick && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-zinc-950 border border-white/10 rounded-lg shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-100 mb-1">Open which page?</h3>
            <p className="text-xs text-zinc-500 mb-3">
              Several wiki pages match{" "}
              <code className="text-zinc-400">[[{wikilinkPick.label}]]</code>
              . Pick the one you want.
            </p>
            <ul className="space-y-2 mb-4">
              {wikilinkPick.candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setWikilinkPick(null);
                      selectWikiPage(c.id);
                    }}
                    className="w-full text-left px-3 py-2 rounded border border-white/10 text-sm text-zinc-200 hover:bg-zinc-900"
                  >
                    <span className="font-medium">{c.title}</span>
                    <span className="block text-[10px] text-zinc-500 mt-0.5">
                      {c.project_slug ? `project · ${c.project_slug}` : "Organization"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setWikilinkPick(null)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {restoreCandidate && page && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-zinc-950 border border-white/10 rounded-lg shadow-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Restore version {restoreCandidate.version}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  by {restoreCandidate.changed_by} · {formatIsoUtc(restoreCandidate.created_at)}
                </p>
              </div>
              <button
                onClick={() => setRestoreCandidate(null)}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-0 h-[420px]">
              <div className="border-r border-white/10 overflow-y-auto">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-zinc-500 border-b border-white/10">
                  Current
                </div>
                <pre className="p-3 text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
                  {page.content}
                </pre>
              </div>
              <div className="overflow-y-auto">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-zinc-500 border-b border-white/10">
                  Version {restoreCandidate.version}
                </div>
                <div className="p-3 space-y-0.5 font-mono text-xs leading-relaxed">
                  {simpleLineDiff(page.content, restoreCandidate.content).map((row, i) => (
                    <div
                      key={i}
                      className={
                        row.type === "add"
                          ? "bg-emerald-500/10 text-emerald-300"
                          : row.type === "remove"
                            ? "bg-red-500/10 text-red-300"
                            : "text-zinc-500"
                      }
                    >
                      {row.type === "add"
                        ? `+ ${row.right || ""}`
                        : row.type === "remove"
                          ? `- ${row.left || ""}`
                          : `  ${row.left || ""}`}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-white/10 flex items-center justify-end gap-2">
              <button
                onClick={() => setRestoreCandidate(null)}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await restoreRevision(restoreCandidate);
                  setRestoreCandidate(null);
                }}
                disabled={saving}
                className="px-3 py-1.5 text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-600/30 disabled:opacity-50"
              >
                {saving ? "Restoring..." : "Restore this version"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function WikiPageRoute() {
  return (
    <Suspense fallback={<div className="p-5 text-sm text-zinc-500">Loading wiki…</div>}>
      <WikiVaultContent />
    </Suspense>
  );
}
