"use client";

/**
 * Contract templates authoring.
 *
 * Lists all templates (file + DB merged). File templates are read-only
 * markers for the 3 bundled ones; DB templates can be created, edited,
 * or archived here without a PR. Body is plain markdown — no TipTap
 * surface because templates aren't a writing-flow, they're a setup-flow
 * that operators touch once and revisit occasionally.
 *
 * Bracket syntax awareness comes from the server-side extractor in
 * /api/contracts/templates which pulls [UPPER_SNAKE] and [TYPE:NAME]
 * both. The variable count shown in the list reflects whatever comes
 * back from that endpoint.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch, opsPost, opsPatch } from "@/lib/ops-api";

interface TemplateListEntry {
  id: string;       // slug for file templates, uuid for DB
  slug: string;
  name: string;
  description: string | null;
  variables: string[];
  source: "file" | "db";
  updated_at?: string;
}

interface TemplateDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  body: string;
  template_type: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export default function TemplatesPage() {
  const [list, setList] = useState<TemplateListEntry[]>([]);
  const [selected, setSelected] = useState<TemplateListEntry | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", description: "", body: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const d = await opsFetch<{ templates: TemplateListEntry[] }>("/api/contracts/templates");
    setList(d?.templates || []);
    setLoading(false);
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  // Load detail for DB templates only. File templates have no detail
  // endpoint because they're not editable here.
  const loadDetail = useCallback(async (entry: TemplateListEntry) => {
    if (entry.source === "file") { setDetail(null); return; }
    const d = await opsFetch<{ template: TemplateDetail }>(`/api/contracts/templates/${entry.id}`);
    setDetail(d?.template || null);
    if (d?.template) {
      setForm({
        name: d.template.name,
        slug: d.template.slug,
        description: d.template.description || "",
        body: d.template.body,
      });
    }
  }, []);

  function startNew() {
    setIsNew(true);
    setSelected(null);
    setDetail(null);
    setForm({ name: "", slug: "", description: "", body: "# [TITLE]\n\nPrepared for [CLIENT_NAME] on [DATE:PROPOSAL_DATE].\n\n" });
    setSaveError(null);
  }

  function pick(entry: TemplateListEntry) {
    setIsNew(false);
    setSelected(entry);
    setSaveError(null);
    if (entry.source === "file") {
      setDetail(null);
      setForm({ name: entry.name, slug: entry.slug, description: "", body: "" });
    } else {
      loadDetail(entry);
    }
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      if (isNew) {
        const r = await opsPost<{ id: string; slug: string }>("/api/contracts/templates", {
          name: form.name.trim(),
          slug: form.slug.trim(),
          description: form.description.trim() || null,
          body: form.body,
        });
        if (r.ok) {
          await loadList();
          setIsNew(false);
          // Select the newly-created row
          const newList = await opsFetch<{ templates: TemplateListEntry[] }>("/api/contracts/templates");
          const created = (newList?.templates || []).find(t => t.id === r.data.id);
          if (created) pick(created);
        } else {
          setSaveError(r.error || "Create failed");
        }
      } else if (detail) {
        const r = await opsPatch(`/api/contracts/templates/${detail.id}`, {
          name: form.name !== detail.name ? form.name : undefined,
          description: (form.description || null) !== (detail.description || null) ? (form.description.trim() || null) : undefined,
          body: form.body !== detail.body ? form.body : undefined,
        });
        if (r.ok) {
          await loadList();
          await loadDetail(selected!);
        } else {
          setSaveError(r.error || "Update failed");
        }
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  }

  async function archive() {
    if (!detail) return;
    if (!window.confirm(`Archive "${detail.name}"? It will be hidden from the new-contract picker. Existing contracts keep their template_id.`)) return;
    const r = await opsPost(`/api/contracts/templates/${detail.id}/archive`);
    if (r.ok) {
      await loadList();
      setSelected(null);
      setDetail(null);
    }
  }

  const editing = isNew || (selected?.source === "db");

  return (
    <div className="flex h-screen">
      {/* List */}
      <div className="w-[320px] border-r border-zinc-800 flex flex-col shrink-0">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <Link href="/contracts" className="text-[10px] text-zinc-500 hover:text-zinc-300">← Contracts</Link>
            <h1 className="text-base font-semibold text-zinc-100 mt-0.5">Templates</h1>
          </div>
          <button
            onClick={startNew}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-4 text-xs text-zinc-500">Loading...</div>}
          {!loading && list.length === 0 && (
            <div className="p-4 text-xs text-zinc-500">No templates.</div>
          )}
          {list.map((t) => (
            <button
              key={`${t.source}:${t.id}`}
              onClick={() => pick(t)}
              className={`w-full text-left px-4 py-2.5 border-b border-zinc-800/30 hover:bg-white/[0.02] transition-colors ${
                selected?.id === t.id && !isNew ? "bg-white/[0.06]" : ""
              }`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`px-1.5 py-0.5 text-[8px] font-mono rounded ${
                  t.source === "db" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-700/60 text-zinc-400"
                }`}>
                  {t.source}
                </span>
                <span className="text-[13px] text-zinc-200 truncate flex-1">{t.name}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                <span className="font-mono">{t.slug}</span>
                <span>·</span>
                <span>{t.variables.length} vars</span>
              </div>
              {t.description && (
                <p className="mt-0.5 text-[10px] text-zinc-500 truncate">{t.description}</p>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Detail / Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected && !isNew ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
            Select a template or create a new one.
          </div>
        ) : selected?.source === "file" ? (
          <div className="p-6 max-w-3xl">
            <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">File-backed template</div>
            <h2 className="text-lg font-semibold text-zinc-100 mb-2">{selected.name}</h2>
            <p className="text-xs text-zinc-500 mb-4">
              This template lives in <code className="px-1 bg-zinc-800 rounded text-zinc-300">agents/executor-contract/</code> and
              is version-controlled with the executor agent's prompt. Edit the file in a PR to change it, or copy
              it to a new DB template here to iterate without a deploy.
            </p>
            <div className="rounded-lg border border-zinc-800 p-3 bg-zinc-950/50">
              <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Variables ({selected.variables.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {selected.variables.map((v) => (
                  <span key={v} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-zinc-800 text-zinc-300">
                    [{v}]
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6 max-w-3xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                  {isNew ? "New template" : "Editing template"}
                </div>
                <h2 className="text-lg font-semibold text-zinc-100 mt-0.5">{form.name || "Untitled"}</h2>
              </div>
              <div className="flex gap-2">
                {!isNew && detail && (
                  <button
                    onClick={archive}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:bg-red-500/30 hover:text-red-200"
                  >
                    Archive
                  </button>
                )}
                <button
                  onClick={save}
                  disabled={saving || !form.name.trim() || !form.slug.trim() || !form.body.trim()}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  {saving ? "Saving..." : (isNew ? "Create" : "Save")}
                </button>
              </div>
            </div>

            {saveError && (
              <div className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-[11px] text-red-300">
                {saveError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Service Agreement (West Coast)"
                  className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Slug</label>
                <input
                  value={form.slug}
                  disabled={!isNew}
                  onChange={(e) => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                  placeholder="service-agreement-west"
                  className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 font-mono focus:outline-none focus:border-amber-500/50 disabled:opacity-60"
                />
                <p className="mt-1 text-[10px] text-zinc-600">Lowercase, hyphens, 2-60 chars. Immutable after create.</p>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Description (optional)</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Short note about when to use this template"
                  className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 mb-1">Body (markdown, with [BRACKET] placeholders)</label>
                <textarea
                  value={form.body}
                  onChange={(e) => setForm(f => ({ ...f, body: e.target.value }))}
                  rows={24}
                  className="w-full px-3 py-2 text-xs bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 font-mono focus:outline-none focus:border-amber-500/50"
                />
                <p className="mt-1 text-[10px] text-zinc-600">
                  Supports <code className="bg-zinc-800 px-1 rounded">[NAME]</code> and typed <code className="bg-zinc-800 px-1 rounded">[DATE:FIELD]</code> placeholders.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
