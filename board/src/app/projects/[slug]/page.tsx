"use client";

import { useEffect, useState, useCallback, use, type FormEvent } from "react";
import Link from "next/link";
import { opsFetch, opsPost, opsPatch, opsDelete } from "@/lib/ops-api";
import WikiGraph, { type GraphNode, type GraphEdge } from "@/components/WikiGraph";
import { usePageContext } from "@/contexts/PageContext";

interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  instructions: string | null;
  classification_floor: string;
  settings: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface Member {
  entity_type: string;
  entity_id: string;
  added_by: string;
  added_at: string;
}

interface ProjectFile {
  document_id: string;
  filename: string | null;
  chunk_count: number;
  uploaded_at: string;
  added_by: string;
}

interface MemoryEntry {
  key: string;
  value: string;
  written_by: string;
  created_at: string;
}

interface WikiArticle {
  id: string;
  title: string;
  classification: string;
  sourceCount: number;
  chunkCount: number;
  wikilinks: string[];
  compiledBy: string;
  createdAt: string;
  updatedAt: string;
}

interface WikiHealth {
  timestamp: string;
  articleCount: number;
  score: number;
  issues: Array<{
    category: string;
    severity: string;
    articleTitle: string;
    message: string;
    suggestion: string;
  }>;
  categories: Record<string, number>;
  durationMs: number;
}

interface CompileStatus {
  pending: number;
  compiled: number;
  wikiArticles: number;
  none: number;
}

interface ProjectSearchResult {
  answer: string | null;
  citations?: Array<{ text: string; similarity: number; documentId: string }>;
  error?: string;
  message?: string;
}

const ENTITY_TYPE_COLORS: Record<string, string> = {
  chat_session: "bg-blue-500/20 text-blue-300",
  campaign: "bg-emerald-500/20 text-emerald-300",
  document: "bg-orange-500/20 text-orange-300",
  contact: "bg-violet-500/20 text-violet-300",
  work_item: "bg-yellow-500/20 text-yellow-300",
};

export default function ProjectDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { setPageFromRoute } = usePageContext();
  const [project, setProject] = useState<Project | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [fileCount, setFileCount] = useState(0);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Editing state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  // Add member form
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberType, setMemberType] = useState("contact");
  const [memberId, setMemberId] = useState("");
  const [addingMember, setAddingMember] = useState(false);

  // Add note form
  const [showAddNote, setShowAddNote] = useState(false);
  const [noteKey, setNoteKey] = useState("");
  const [noteValue, setNoteValue] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Wiki tab
  const [activeTab, setActiveTab] = useState<"overview" | "wiki">("overview");
  const [wikiArticles, setWikiArticles] = useState<WikiArticle[]>([]);
  const [wikiHealth, setWikiHealth] = useState<WikiHealth | null>(null);
  const [compileStatus, setCompileStatus] = useState<CompileStatus | null>(null);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [linting, setLinting] = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<string | null>(null);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [showGraph, setShowGraph] = useState(true);
  const [ragQuery, setRagQuery] = useState("");
  const [ragProjectOnly, setRagProjectOnly] = useState(false);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragResult, setRagResult] = useState<ProjectSearchResult | null>(null);

  const load = useCallback(async () => {
    const data = await opsFetch<{
      project: Project;
      counts: Record<string, number>;
      memory: MemoryEntry[];
      recentMembers: Member[];
      files: ProjectFile[];
      fileCount?: number;
      filesTruncated?: boolean;
    }>(`/api/projects/detail?slug=${slug}`);
    if (data) {
      setProject(data.project);
      setCounts(data.counts || {});
      setMemory(data.memory || []);
      setMembers(data.recentMembers || []);
      setFiles(data.files || []);
      // STAQPRO-545: the API caps the file list (large projects link thousands of
      // docs). Track the true total + truncation so the UI can say "showing N of M".
      setFileCount(data.fileCount ?? data.files?.length ?? 0);
      setFilesTruncated(Boolean(data.filesTruncated));
    }
    setLoading(false);
  }, [slug]);

  const loadWiki = useCallback(async () => {
    setWikiLoading(true);
    const [arts, health, status, graph] = await Promise.all([
      opsFetch<{ articles: WikiArticle[] }>(`/api/projects/wiki?slug=${slug}`),
      opsFetch<WikiHealth>(`/api/projects/wiki/health?slug=${slug}`),
      opsFetch<CompileStatus>(`/api/projects/wiki/status?slug=${slug}`),
      opsFetch<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/projects/wiki/graph?slug=${slug}`),
    ]);
    setWikiArticles(arts?.articles || []);
    setWikiHealth(health);
    setCompileStatus(status);
    setGraphNodes(graph?.nodes || []);
    setGraphEdges(graph?.edges || []);
    setWikiLoading(false);
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // Push page context for context-aware chat
  useEffect(() => {
    setPageFromRoute(`/projects/${slug}`, {
      entityType: 'project',
      entityId: slug,
      metadata: project ? { name: project.name, classification: project.classification_floor } : undefined,
    });
    return () => setPageFromRoute('/', {});
  }, [slug, project?.name, project?.classification_floor, setPageFromRoute]);

  useEffect(() => {
    if (activeTab === "wiki") loadWiki();
  }, [activeTab, loadWiki]);

  function startEdit() {
    if (!project) return;
    setEditName(project.name);
    setEditDesc(project.description || "");
    setEditInstructions(project.instructions || "");
    setEditing(true);
  }

  async function saveEdit() {
    setSaving(true);
    const result = await opsPatch(`/api/projects?slug=${slug}`, {
      slug,
      name: editName,
      description: editDesc || null,
      instructions: editInstructions || null,
    });
    setSaving(false);
    if (result.ok) {
      setEditing(false);
      await load();
    }
  }

  async function handleAddMember() {
    if (!memberId.trim()) return;
    setAddingMember(true);
    const result = await opsPost("/api/projects/members", {
      slug,
      entity_type: memberType,
      entity_id: memberId.trim(),
    });
    setAddingMember(false);
    if (result.ok) {
      setMemberId("");
      setShowAddMember(false);
      await load();
    }
  }

  async function handleAddNote() {
    if (!noteKey.trim() || !noteValue.trim()) return;
    setAddingNote(true);
    const result = await opsPost("/api/projects/memory", {
      slug,
      key: noteKey.trim(),
      value: noteValue.trim(),
    });
    setAddingNote(false);
    if (result.ok) {
      setNoteKey("");
      setNoteValue("");
      setShowAddNote(false);
      await load();
    }
  }

  async function handleCompile() {
    setCompiling(true);
    await opsPost("/api/projects/compile", { slug, maxArticles: 20, allPending: true });
    setCompiling(false);
    await loadWiki();
  }

  async function handleLint() {
    setLinting(true);
    const result = await opsPost<WikiHealth>("/api/projects/wiki/lint", { slug });
    if (result.ok) setWikiHealth(result.data);
    setLinting(false);
  }

  async function handleProjectSearch(e: FormEvent) {
    e.preventDefault();
    if (!ragQuery.trim() || ragLoading) return;
    setRagLoading(true);
    setRagResult(null);
    const res = await opsPost<ProjectSearchResult>("/api/search", {
      query: ragQuery.trim(),
      projectSlug: slug,
      projectOnly: ragProjectOnly,
    });
    setRagLoading(false);
    if (res.ok) {
      setRagResult(res.data);
    } else {
      setRagResult({ answer: null, error: res.error });
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading project...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Project not found</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Link href="/projects" className="hover:text-zinc-300 transition-colors">Projects</Link>
          <span>/</span>
          <span className="text-zinc-300">{project.name}</span>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-500 border border-white/5">
                {project.classification_floor}
              </span>
              <span className="text-xs text-zinc-500">by {project.created_by}</span>
            </div>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Name</label>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Description</label>
                  <textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    rows={2}
                    className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 resize-y"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Instructions</label>
                  <textarea
                    value={editInstructions}
                    onChange={(e) => setEditInstructions(e.target.value)}
                    rows={4}
                    placeholder="Agent instructions for this project context..."
                    className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono focus:outline-none focus:border-emerald-500/50 resize-y"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={saveEdit}
                    disabled={saving}
                    className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white rounded transition-colors"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-lg font-semibold text-zinc-100">{project.name}</h1>
                {project.description && (
                  <p className="text-sm text-zinc-400 mt-1">{project.description}</p>
                )}
                {project.instructions && (
                  <div className="mt-3 bg-zinc-900 border border-white/5 rounded-lg p-3">
                    <div className="text-[10px] text-zinc-500 font-medium mb-1 uppercase tracking-wider">Instructions</div>
                    <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{project.instructions}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
          {!editing && (
            <button
              onClick={startEdit}
              className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 transition-colors shrink-0"
            >
              Edit
            </button>
          )}
        </div>

        {/* Entity Counts */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(["chat_session", "campaign", "document", "contact"] as const).map((type) => (
            <div key={type} className="bg-zinc-900 border border-white/5 rounded-lg p-3">
              <div className="text-xs text-zinc-500 mb-1 capitalize">{type.replace("_", " ")}s</div>
              <div className="text-sm font-medium text-zinc-200">{counts[type] || 0}</div>
            </div>
          ))}
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
            <div className="text-xs text-zinc-500 mb-1">Wiki Articles</div>
            <div className="text-sm font-medium text-zinc-200">{compileStatus?.wikiArticles || 0}</div>
          </div>
        </div>

        {/* Project RAG */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-sm font-medium text-zinc-300">Project RAG</h3>
            <Link href={`/search?project=${encodeURIComponent(slug)}`} className="text-xs text-zinc-500 hover:text-zinc-300">
              Open full search
            </Link>
          </div>
          <form onSubmit={handleProjectSearch} className="space-y-2">
            <div className="flex gap-2">
              <input
                value={ragQuery}
                onChange={(e) => setRagQuery(e.target.value)}
                placeholder="Ask this project's knowledge base..."
                className="flex-1 bg-zinc-800 border border-white/10 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                type="submit"
                disabled={ragLoading || !ragQuery.trim()}
                className="px-3 py-2 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded transition-colors"
              >
                {ragLoading ? "Searching..." : "Search"}
              </button>
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={ragProjectOnly}
                onChange={(e) => setRagProjectOnly(e.target.checked)}
                className="rounded border-zinc-600"
              />
              Project-only (otherwise project + full KB)
            </label>
          </form>
          {ragResult?.answer && (
            <div className="mt-3 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
              {ragResult.answer}
            </div>
          )}
          {ragResult?.message && !ragResult.answer && (
            <div className="mt-3 text-xs text-zinc-500">{ragResult.message}</div>
          )}
          {ragResult?.error && (
            <div className="mt-3 text-xs text-red-400">{ragResult.error}</div>
          )}
        </div>

        {/* Tab Switcher */}
        <div className="flex gap-1 bg-zinc-900 border border-white/5 rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${activeTab === "overview" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab("wiki")}
            className={`px-3 py-1.5 text-xs rounded transition-colors flex items-center gap-1.5 ${activeTab === "wiki" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            Wiki
            {compileStatus && compileStatus.pending > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/20 text-amber-300">
                {compileStatus.pending}
              </span>
            )}
          </button>
        </div>

        {/* Wiki Tab */}
        {activeTab === "wiki" && (
          <div className="space-y-4">
            {/* Compile Status Bar */}
            <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-zinc-300">Wiki Compilation</h3>
                <div className="flex gap-2">
                  <button
                    onClick={handleLint}
                    disabled={linting || wikiArticles.length === 0}
                    className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 disabled:opacity-40 transition-colors"
                  >
                    {linting ? "Linting..." : "Run Lint"}
                  </button>
                  <button
                    onClick={handleCompile}
                    disabled={compiling || !compileStatus || compileStatus.pending === 0}
                    className="px-3 py-1.5 text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-600/30 disabled:opacity-40 transition-colors"
                  >
                    {compiling ? "Compiling..." : `Compile ${compileStatus?.pending || 0} Pending`}
                  </button>
                </div>
              </div>
              {compileStatus && (
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div>
                    <div className="text-lg font-bold text-amber-300">{compileStatus.pending}</div>
                    <div className="text-[10px] text-zinc-500">Pending</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-emerald-300">{compileStatus.compiled}</div>
                    <div className="text-[10px] text-zinc-500">Compiled</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-blue-300">{compileStatus.wikiArticles}</div>
                    <div className="text-[10px] text-zinc-500">Articles</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-zinc-400">{compileStatus.none}</div>
                    <div className="text-[10px] text-zinc-500">Untracked</div>
                  </div>
                </div>
              )}
            </div>

            {/* Knowledge Graph */}
            <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-300">Knowledge Graph</h3>
                <button
                  onClick={() => setShowGraph(!showGraph)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showGraph ? "Hide" : "Show"}
                </button>
              </div>
              {showGraph && (
                <WikiGraph
                  nodes={graphNodes}
                  edges={graphEdges}
                  height={420}
                  onNodeClick={(id) => setSelectedArticle(selectedArticle === id ? null : id)}
                />
              )}
            </div>

            {/* Health Score */}
            {wikiHealth && wikiHealth.articleCount > 0 && (
              <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-zinc-300">Health Report</h3>
                  <div className="flex items-center gap-2">
                    <span className={`text-2xl font-bold ${wikiHealth.score >= 80 ? "text-emerald-400" : wikiHealth.score >= 50 ? "text-amber-400" : "text-red-400"}`}>
                      {wikiHealth.score}
                    </span>
                    <span className="text-xs text-zinc-500">/ 100</span>
                  </div>
                </div>
                <div className="grid grid-cols-5 gap-2 mb-3">
                  {Object.entries(wikiHealth.categories).map(([cat, count]) => (
                    <div key={cat} className="text-center">
                      <div className={`text-sm font-medium ${count > 0 ? "text-amber-300" : "text-zinc-500"}`}>{count}</div>
                      <div className="text-[10px] text-zinc-600 capitalize">{cat}</div>
                    </div>
                  ))}
                </div>
                {wikiHealth.issues.length > 0 && (
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {wikiHealth.issues.slice(0, 10).map((issue, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                          issue.severity === "error" ? "bg-red-500/20 text-red-300" :
                          issue.severity === "warning" ? "bg-amber-500/20 text-amber-300" :
                          "bg-zinc-700 text-zinc-400"
                        }`}>
                          {issue.severity}
                        </span>
                        <span className="text-zinc-400">{issue.message}</span>
                      </div>
                    ))}
                    {wikiHealth.issues.length > 10 && (
                      <div className="text-[10px] text-zinc-600 pt-1">
                        + {wikiHealth.issues.length - 10} more issues
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Articles List */}
            {wikiLoading ? (
              <div className="text-center py-8 text-zinc-500 text-sm">Loading wiki...</div>
            ) : wikiArticles.length === 0 ? (
              <div className="bg-zinc-900 border border-white/5 rounded-lg p-8 text-center">
                <div className="text-zinc-500 text-sm mb-2">No wiki articles yet</div>
                <div className="text-zinc-600 text-xs">
                  {compileStatus && compileStatus.pending > 0
                    ? `${compileStatus.pending} vault docs ready to compile`
                    : "Ingest vault documents first, then compile them into wiki articles"}
                </div>
              </div>
            ) : (
              <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5">
                  <h3 className="text-sm font-medium text-zinc-300">
                    Articles ({wikiArticles.length})
                  </h3>
                </div>
                <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto">
                  {wikiArticles.map((article) => (
                    <div
                      key={article.id}
                      className={`px-4 py-3 cursor-pointer transition-colors ${selectedArticle === article.id ? "bg-zinc-800" : "hover:bg-zinc-900/80"}`}
                      onClick={() => setSelectedArticle(selectedArticle === article.id ? null : article.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-zinc-200 truncate">{article.title}</div>
                          <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-600">
                            <span>{article.sourceCount} source{article.sourceCount !== 1 ? "s" : ""}</span>
                            <span>{article.chunkCount} chunks</span>
                            <span>by {article.compiledBy}</span>
                          </div>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                          article.classification === "CONFIDENTIAL" ? "bg-red-500/20 text-red-300" :
                          article.classification === "INTERNAL" ? "bg-zinc-700 text-zinc-400" :
                          "bg-blue-500/20 text-blue-300"
                        }`}>
                          {article.classification}
                        </span>
                      </div>
                      {/* Expanded: show wikilinks */}
                      {selectedArticle === article.id && article.wikilinks.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-white/5">
                          <div className="text-[10px] text-zinc-500 mb-1">Links to:</div>
                          <div className="flex flex-wrap gap-1">
                            {article.wikilinks.map((link, i) => (
                              <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-300 border border-blue-500/20">
                                [[{link}]]
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Overview Tab: File Upload + Members */}
        {activeTab === "overview" && <>

        {/* File Upload + File List */}
        <FileUploadSection slug={slug} files={files} fileCount={fileCount} filesTruncated={filesTruncated} onUpload={load} />

        {/* Members */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Members</h3>
            <button
              onClick={() => setShowAddMember(!showAddMember)}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              {showAddMember ? "Cancel" : "Add Member"}
            </button>
          </div>
          {showAddMember && (
            <div className="px-4 py-3 border-b border-white/5 bg-zinc-950/50 flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Type</label>
                <select
                  value={memberType}
                  onChange={(e) => setMemberType(e.target.value)}
                  className="w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none"
                >
                  <option value="contact">Contact</option>
                  <option value="chat_session">Chat Session</option>
                  <option value="campaign">Campaign</option>
                  <option value="work_item">Work Item</option>
                </select>
              </div>
              <div className="flex-[2]">
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Entity ID</label>
                <input
                  value={memberId}
                  onChange={(e) => setMemberId(e.target.value)}
                  placeholder="user@example.com or UUID"
                  className="w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                />
              </div>
              <button
                onClick={handleAddMember}
                disabled={addingMember || !memberId.trim()}
                className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors shrink-0"
              >
                {addingMember ? "Adding..." : "Add"}
              </button>
            </div>
          )}
          {members.filter(m => m.entity_type !== 'document').length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-sm">No members yet</div>
          ) : (
            <div className="divide-y divide-white/5 max-h-[300px] overflow-y-auto">
              {members.filter(m => m.entity_type !== 'document').map((m, i) => (
                <div key={i} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ENTITY_TYPE_COLORS[m.entity_type] || "bg-zinc-700 text-zinc-400"}`}>
                    {m.entity_type}
                  </span>
                  <span className="text-zinc-300 font-mono truncate flex-1">{m.entity_id}</span>
                  <span className="text-zinc-600 shrink-0">by {m.added_by}</span>
                  <span className="text-zinc-600 shrink-0">{new Date(m.added_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Memory */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Memory</h3>
            <button
              onClick={() => setShowAddNote(!showAddNote)}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              {showAddNote ? "Cancel" : "Add Note"}
            </button>
          </div>
          {showAddNote && (
            <div className="px-4 py-3 border-b border-white/5 bg-zinc-950/50 space-y-2">
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Key</label>
                <input
                  value={noteKey}
                  onChange={(e) => setNoteKey(e.target.value)}
                  placeholder="e.g. goal, tech_stack, decisions"
                  className="w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Value</label>
                <textarea
                  value={noteValue}
                  onChange={(e) => setNoteValue(e.target.value)}
                  placeholder="Memory content..."
                  rows={3}
                  className="w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 resize-y"
                />
              </div>
              <button
                onClick={handleAddNote}
                disabled={addingNote || !noteKey.trim() || !noteValue.trim()}
                className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
              >
                {addingNote ? "Saving..." : "Save Note"}
              </button>
            </div>
          )}
          {memory.length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-sm">No memory entries yet</div>
          ) : (
            <div className="divide-y divide-white/5 max-h-[400px] overflow-y-auto">
              {memory.map((m, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-zinc-300">{m.key}</span>
                    <span className="text-[10px] text-zinc-600">by {m.written_by}</span>
                    <span className="text-[10px] text-zinc-600 ml-auto">{new Date(m.created_at).toLocaleString()}</span>
                  </div>
                  <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">{m.value}</pre>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span>ID: <code className="text-zinc-600">{project.id.slice(0, 8)}</code></span>
            <span>Slug: <code className="text-zinc-600">{project.slug}</code></span>
            <span>Created: {new Date(project.created_at).toLocaleString()}</span>
            <span>Updated: {new Date(project.updated_at).toLocaleString()}</span>
          </div>
        </div>

        </>}
      </div>
    </div>
  );
}

// ── File Upload Section ───────────────────────────────────────────────────────

function FileUploadSection({ slug, files, fileCount, filesTruncated, onUpload }: { slug: string; files: ProjectFile[]; fileCount?: number; filesTruncated?: boolean; onUpload: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const TEXT_EXTENSIONS = new Set([
    "md", "txt", "json", "ts", "tsx", "js", "jsx", "css", "html", "py",
    "yaml", "yml", "toml", "sh", "sql", "csv", "xml", "rs", "go", "rb",
  ]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);

    for (const file of Array.from(fileList)) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!TEXT_EXTENSIONS.has(ext)) {
        alert(`Unsupported file type: .${ext}`);
        continue;
      }
      if (file.size > 500 * 1024) {
        alert(`File too large: ${file.name} (max 500KB)`);
        continue;
      }

      const content = await file.text();
      await opsPost<{ chunkCount: number }>("/api/projects/upload", {
        slug,
        fileName: file.name,
        content,
      });
    }

    setUploading(false);
    onUpload();
  }

  async function handleDeleteFile(documentId: string) {
    setDeletingId(documentId);
    const result = await opsDelete(
      `/api/projects/members?slug=${encodeURIComponent(slug)}&entity_type=document&entity_id=${encodeURIComponent(documentId)}`
    );
    setDeletingId(null);
    if (result.ok) onUpload();
  }

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
      {/* Upload area */}
      <div
        className={`p-4 transition-colors ${dragOver ? "border-b border-emerald-500/50 bg-emerald-950/20" : "border-b border-white/5"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-zinc-300">Files</h3>
            <p className="text-[10px] text-zinc-600 mt-0.5">Drop files or click to upload into project knowledge base</p>
          </div>
          <label className={`px-3 py-1.5 text-xs rounded cursor-pointer transition-colors ${uploading ? "bg-zinc-700 text-zinc-500" : "bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/30"}`}>
            {uploading ? "Uploading..." : "Choose Files"}
            <input
              type="file"
              multiple
              accept=".md,.txt,.json,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.sql,.csv,.xml,.html,.css,.sh,.toml,.rs,.go,.rb"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
              disabled={uploading}
            />
          </label>
        </div>
      </div>

      {/* File list */}
      {files.length === 0 ? (
        <div className="p-6 text-center text-zinc-500 text-sm">No files uploaded yet</div>
      ) : (
        <div className="divide-y divide-white/5 max-h-[300px] overflow-y-auto">
          {files.map((f) => (
            <div key={f.document_id} className="px-4 py-2.5 flex items-center gap-3 text-xs group">
              <span className="text-zinc-500 shrink-0">&#128196;</span>
              <span className="text-zinc-200 truncate flex-1">{f.filename || f.document_id.slice(0, 8)}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500/20 text-orange-300 shrink-0">
                {f.chunk_count} chunk{f.chunk_count !== 1 ? "s" : ""}
              </span>
              <span className="text-zinc-600 shrink-0">by {f.added_by}</span>
              <span className="text-zinc-600 shrink-0">{new Date(f.uploaded_at).toLocaleDateString()}</span>
              <button
                onClick={() => handleDeleteFile(f.document_id)}
                disabled={deletingId === f.document_id}
                className="text-zinc-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 shrink-0 disabled:opacity-50"
                title="Remove from project"
              >
                {deletingId === f.document_id ? "..." : "\u2715"}
              </button>
            </div>
          ))}
          {filesTruncated && (
            <div className="px-4 py-2.5 text-[11px] text-zinc-500 text-center">
              Showing {files.length} of {fileCount ?? files.length} files (most recent first).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
