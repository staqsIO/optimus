"use client";

// ADR-017 v1 §10 — Groups admin: org admins create groups, add members,
// and use them as share targets (gate active in the composer).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface Group {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  org_id: string;
  member_count: number;
  created_at: string;
}
interface OrgMembership { org_id: string; org_name: string; role: string; }
interface BoardMember { id: string; display_name: string | null; github_username: string; }

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<Group | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [g, m, bm] = await Promise.all([
      opsFetch<{ groups: Group[] }>("/api/sharing/groups"),
      opsFetch<{ org_memberships: OrgMembership[] }>("/api/sharing/me"),
      opsFetch<{ members: BoardMember[] }>("/api/board-members"),
    ]);
    setGroups(g?.groups || []);
    setMemberships(m?.org_memberships || []);
    setMembers(bm?.members || []);
    setLoading(false);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const adminOrgs = memberships.filter((m) => m.role === "owner" || m.role === "admin");

  const onDelete = async (id: string) => {
    if (!confirm("Delete this group? Membership rows are deleted; any active share grants targeting this group are NOT auto-revoked (run /sharing to inspect).")) return;
    const r = await fetch("/api/ops", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/api/sharing/groups/${id}` }),
    });
    if (!r.ok) setErr(`Delete failed (${r.status})`);
    else reload();
  };

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-light text-zinc-100 mb-1">Groups</h1>
          <p className="text-xs text-zinc-500">
            Subdivisions within an org. Org admins create them; members are added
            from existing org membership.{" "}
            <Link href="/sharing" className="text-violet-300 hover:text-violet-200">← back to Sharing</Link>
          </p>
        </div>
        {adminOrgs.length > 0 && (
          <button
            className="text-xs px-3 py-1.5 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
            onClick={() => setCreating(true)}
          >
            New group
          </button>
        )}
      </div>

      {err && (
        <div className="mb-4 text-xs text-rose-300 bg-rose-500/10 border border-rose-400/30 rounded px-3 py-2">
          {err}<button className="ml-2 underline" onClick={() => setErr(null)}>dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="text-sm text-zinc-500 italic">
          {adminOrgs.length === 0 ? "No groups visible. (Group creation requires org owner/admin role.)" : "No groups yet."}
        </div>
      ) : (
        <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden bg-white/[0.02]">
          {groups.map((g) => {
            const isAdmin = adminOrgs.some((m) => m.org_id === g.org_id);
            const orgName = memberships.find((m) => m.org_id === g.org_id)?.org_name || g.org_id.slice(0, 8);
            return (
              <li key={g.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-100">
                    {g.name} <span className="text-[10px] text-violet-400 ml-2">{orgName}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {g.slug} · {g.member_count} member{g.member_count === 1 ? "" : "s"}
                    {g.description ? ` · ${g.description}` : ""}
                  </div>
                </div>
                <div className="flex gap-2 ml-3">
                  {isAdmin && (
                    <button
                      onClick={() => setManaging(g)}
                      className="text-[11px] px-2.5 py-1 rounded border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]"
                    >
                      Members
                    </button>
                  )}
                  <Link
                    href={`/sharing?target_type=group&target_id=${g.id}`}
                    className="text-[11px] px-2.5 py-1 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
                  >
                    Share with group
                  </Link>
                  {isAdmin && (
                    <button
                      onClick={() => onDelete(g.id)}
                      className="text-[11px] px-2.5 py-1 rounded border border-rose-400/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <CreateGroup
          adminOrgs={adminOrgs}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
        />
      )}
      {managing && (
        <ManageMembers
          group={managing}
          members={members}
          onClose={() => setManaging(null)}
          onChanged={() => { setManaging(null); reload(); }}
        />
      )}
    </div>
  );
}

function CreateGroup({ adminOrgs, onClose, onCreated }: {
  adminOrgs: OrgMembership[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [orgId, setOrgId] = useState(adminOrgs[0]?.org_id || "");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    const res = await opsPost("/api/sharing/groups", { name, slug, description, org_id: orgId });
    setSubmitting(false);
    if (!res.ok) setErr(res.error);
    else onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-md p-6">
        <h2 className="text-sm text-zinc-100 font-medium mb-3">New group</h2>
        <label className="block text-[11px] text-zinc-500 mb-1">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)}
               className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3" />
        <label className="block text-[11px] text-zinc-500 mb-1">Slug</label>
        <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))}
               className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 font-mono mb-3" />
        <label className="block text-[11px] text-zinc-500 mb-1">Description (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)}
               className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3" />
        <label className="block text-[11px] text-zinc-500 mb-1">Organization</label>
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)}
                className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3">
          {adminOrgs.map((m) => <option key={m.org_id} value={m.org_id}>{m.org_name}</option>)}
        </select>
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

function ManageMembers({ group, members, onClose, onChanged }: {
  group: Group;
  members: BoardMember[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const addSelected = async () => {
    setSubmitting(true);
    const res = await opsPost(`/api/sharing/groups/${group.id}/members`, {
      user_ids: Array.from(selected),
    });
    setSubmitting(false);
    if (!res.ok) setErr(res.error);
    else onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-md p-6 max-h-[80vh] overflow-y-auto">
        <h2 className="text-sm text-zinc-100 font-medium mb-1">{group.name} · members</h2>
        <p className="text-[11px] text-zinc-500 mb-4">
          Only users who are already members of <span className="font-mono">{group.org_id.slice(0, 8)}</span> can be added.
          Removing members is a separate step (run a SQL delete on tenancy.group_memberships for now).
        </p>
        <div className="space-y-1 mb-4 border border-white/10 rounded-lg max-h-64 overflow-y-auto p-2">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-xs text-zinc-200 hover:bg-white/[0.03] px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={(e) => {
                  const s = new Set(selected);
                  if (e.target.checked) s.add(m.id); else s.delete(m.id);
                  setSelected(s);
                }}
              />
              {m.display_name || m.github_username}
              <span className="text-[10px] text-zinc-500 font-mono ml-auto">{m.id.slice(0, 8)}</span>
            </label>
          ))}
        </div>
        {err && <div className="text-xs text-rose-300 mb-2">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-200">Close</button>
          <button disabled={selected.size === 0 || submitting} onClick={addSelected}
                  className="text-xs px-3 py-1.5 rounded border border-violet-400/40 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 disabled:opacity-40">
            {submitting ? "Adding…" : `Add ${selected.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}
