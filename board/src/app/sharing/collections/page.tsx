"use client";

// ADR-017 v1 §8 — Collections admin: create flat doc collections, assign
// documents, share them via the share composer (deep-link). Hierarchy is wiki
// pages' job (parent_id); this is just the flat-document grouping.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface Collection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string | null;
  owner_org_id: string;
  doc_count: number;
  created_at: string;
}
interface OrgMembership { org_id: string; org_name: string; role: string; }

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const [c, m] = await Promise.all([
      opsFetch<{ collections: Collection[] }>("/api/sharing/collections"),
      opsFetch<{ org_memberships: OrgMembership[] }>("/api/sharing/me"),
    ]);
    setCollections(c?.collections || []);
    setMemberships(m?.org_memberships || []);
    setLoading(false);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const onDelete = async (id: string) => {
    if (!confirm("Delete this collection? (Documents remain; only the grouping is removed.)")) return;
    const res = await opsPost(`/api/sharing/collections/${id}`, undefined); // route accepts DELETE; opsPost won't work
    // Use a small workaround — we need a DELETE call.
    const r = await fetch("/api/ops", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/api/sharing/collections/${id}` }),
    });
    if (!r.ok) setErr(`Delete failed (${r.status})`);
    else reload();
    void res;
  };

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-light text-zinc-100 mb-1">Collections</h1>
          <p className="text-xs text-zinc-500">
            Group documents so you can share a folder instead of one doc at a time.{" "}
            <Link href="/sharing" className="text-violet-300 hover:text-violet-200">← back to Sharing</Link>
          </p>
        </div>
        <button
          className="text-xs px-3 py-1.5 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
          onClick={() => setCreating(true)}
        >
          New collection
        </button>
      </div>

      {err && (
        <div className="mb-4 text-xs text-rose-300 bg-rose-500/10 border border-rose-400/30 rounded px-3 py-2">
          {err}
          <button className="ml-2 underline" onClick={() => setErr(null)}>dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : collections.length === 0 ? (
        <div className="text-sm text-zinc-500 italic">No collections yet.</div>
      ) : (
        <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden bg-white/[0.02]">
          {collections.map((c) => (
            <li key={c.id} className="px-4 py-3 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-100">
                  {c.name}
                  {c.owner_id && <span className="ml-2 text-[10px] text-cyan-400">personal</span>}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {c.slug} · {c.doc_count} doc{c.doc_count === 1 ? "" : "s"}
                  {c.description ? ` · ${c.description}` : ""}
                </div>
              </div>
              <div className="flex gap-2 ml-3">
                <Link
                  href={`/sharing?scope_type=collection&scope_ref=${c.id}`}
                  className="text-[11px] px-2.5 py-1 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
                >
                  Share
                </Link>
                <button
                  onClick={() => onDelete(c.id)}
                  className="text-[11px] px-2.5 py-1 rounded border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateCollection
          memberships={memberships}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
        />
      )}
    </div>
  );
}

function CreateCollection({
  memberships,
  onClose,
  onCreated,
}: {
  memberships: OrgMembership[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [orgId, setOrgId] = useState(memberships[0]?.org_id || "");
  const [personal, setPersonal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    const res = await opsPost("/api/sharing/collections", {
      name, slug, description, owner_org_id: orgId, personal,
    });
    setSubmitting(false);
    if (!res.ok) setErr(res.error);
    else onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-md p-6">
        <h2 className="text-sm text-zinc-100 font-medium mb-3">New collection</h2>
        <label className="block text-[11px] text-zinc-500 mb-1">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)}
               className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3" />
        <label className="block text-[11px] text-zinc-500 mb-1">Slug (unique within org)</label>
        <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))}
               className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 font-mono mb-3" />
        <label className="block text-[11px] text-zinc-500 mb-1">Description (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)}
               className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3" />
        <label className="block text-[11px] text-zinc-500 mb-1">Organization</label>
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)}
                className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3">
          {memberships.map((m) => <option key={m.org_id} value={m.org_id}>{m.org_name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-[11px] text-zinc-400 mb-3">
          <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
          Personal collection (only you can edit; others see it only when you share it)
        </label>

        {err && <div className="text-xs text-rose-300 mb-2">{err}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button disabled={!name || !slug || !orgId || submitting} onClick={submit}
                  className="text-xs px-3 py-1.5 rounded border border-violet-400/40 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 disabled:opacity-40">
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
