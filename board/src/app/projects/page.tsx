"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  classification_floor: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  chat_count: string;
  campaign_count: string;
  document_count: string;
  contact_count: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const data = await opsFetch<{ projects: Project[] }>("/api/projects");
    setProjects(data?.projects || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function slugify(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
  }

  async function handleCreate() {
    if (!formName.trim()) return;
    setCreating(true);
    const result = await opsPost("/api/projects", {
      name: formName.trim(),
      slug: slugify(formName),
      description: formDesc.trim() || null,
    });
    setCreating(false);
    if (result.ok) {
      setFormName("");
      setFormDesc("");
      setShowForm(false);
      await load();
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading projects...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-100">Projects</h1>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-3 py-1.5 text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-600/30 transition-colors"
          >
            {showForm ? "Cancel" : "New Project"}
          </button>
        </div>

        {/* New Project Form */}
        {showForm && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My Project"
                className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
              />
              {formName && (
                <div className="text-[10px] text-zinc-600 mt-1">
                  Slug: {slugify(formName)}
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Description</label>
              <textarea
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="What is this project about?"
                rows={2}
                className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 resize-y"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating || !formName.trim()}
              className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
            >
              {creating ? "Creating..." : "Create Project"}
            </button>
          </div>
        )}

        {/* Project Cards */}
        {projects.length === 0 ? (
          <div className="text-center py-16 text-zinc-500 text-sm">
            No projects yet. Create one to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {projects.map((p) => {
              const memberCount =
                parseInt(p.chat_count || "0") +
                parseInt(p.campaign_count || "0") +
                parseInt(p.document_count || "0") +
                parseInt(p.contact_count || "0");
              return (
                <Link
                  key={p.id}
                  href={`/projects/${p.slug}`}
                  className="bg-zinc-900 border border-white/5 rounded-lg p-4 hover:bg-zinc-900/80 hover:border-white/10 transition-colors block"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-medium text-zinc-200 truncate">{p.name}</h2>
                      {p.description && (
                        <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{p.description}</p>
                      )}
                    </div>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-500 border border-white/5 shrink-0">
                      {p.classification_floor}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-3 text-[11px] text-zinc-600">
                    <span>{memberCount} entities</span>
                    <span>by {p.created_by}</span>
                    <span className="ml-auto">{new Date(p.created_at).toLocaleDateString()}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
