"use client";

// ADR-017 — Knowledge Share grant management UI.
//
// v0 surface: three lanes (Sharing with you / You are sharing / Pending), a
// "Share knowledge" composer, accept/decline/revoke actions. Scope is fixed
// to "all my knowledge" — v1 adds per-doc/collection scope, v0 hides the
// group target picker behind a feature flag.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { usePrincipalNames, formatPrincipal, type PrincipalRef } from "@/lib/usePrincipalNames";

type PrincipalType = "user" | "group" | "org";
type ScopeType = "all" | "collection" | "document" | "topic";
type Status = "pending" | "active" | "revoked" | "declined" | "expired";

interface Grant {
  id: string;
  granter_type: PrincipalType;
  granter_id: string;
  granter_org_id: string;
  target_type: PrincipalType;
  target_id: string;
  target_org_id: string;
  scope_type: ScopeType;
  scope_ref: string | null;
  status: Status;
  requires_acceptance: boolean;
  created_at: string;
  created_by: string;
  accepted_at: string | null;
  declined_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  direction?: "outgoing" | "incoming";
}

interface GrantsResponse {
  grants: Grant[];
  incoming: Grant[];
  outgoing: Grant[];
  pending: Grant[];
}

interface Org {
  id: string;
  name: string;
  slug: string;
}

interface BoardMember {
  id: string;
  display_name: string | null;
  github_username: string;
}

const GROUPS_UI_ENABLED = true; // v1: groups schema is live, picker active.

interface OrgMembership {
  org_id: string;
  org_name: string;
  org_slug: string;
  role: "owner" | "admin" | "member" | "viewer";
}

interface Group {
  id: string;
  name: string;
  slug: string;
  org_id: string;
  member_count: number;
}

interface Collection {
  id: string;
  name: string;
  slug: string;
  owner_id: string | null;
  owner_org_id: string;
  doc_count: number;
}

interface Topic {
  id: string;
  name: string;
  slug: string;
  owner_org_id: string;
  doc_count: number;
  wiki_count: number;
}

function fmtRel(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function SharingPageInner() {
  const [data, setData] = useState<GrantsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  // Deep-link prefill: /sharing?scope_type=document&scope_ref=<uuid>
  // Other places in the app (document detail, collection detail) link here
  // to invoke the composer pre-filled with their scope.
  const params = useSearchParams();
  const initialScope = useMemo(() => {
    const scope_type = params.get("scope_type") as ScopeType | null;
    const scope_ref = params.get("scope_ref");
    if (scope_type && scope_type !== "all" && scope_ref) {
      return { scope_type, scope_ref };
    }
    return undefined;
  }, [params]);
  useEffect(() => {
    if (initialScope) setComposerOpen(true);
  }, [initialScope]);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await opsFetch<GrantsResponse>("/api/sharing/grants");
    if (res) setData(res);
    else setError("Could not load grants");
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onLifecycle = async (id: string, action: "accept" | "decline" | "revoke") => {
    const res = await opsPost(`/api/sharing/grants/${id}/${action}`);
    if (!res.ok) setError(res.error);
    else reload();
  };

  // Hydrate every granter + target referenced on the page in one batch.
  const principalRefs = useMemo<PrincipalRef[]>(() => {
    const all = [
      ...(data?.incoming || []),
      ...(data?.outgoing || []),
      ...(data?.pending || []),
    ];
    const refs: PrincipalRef[] = [];
    for (const g of all) {
      refs.push({ type: g.granter_type, id: g.granter_id });
      refs.push({ type: g.target_type,  id: g.target_id });
    }
    return refs;
  }, [data]);
  const names = usePrincipalNames(principalRefs);

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-light text-zinc-100 mb-1">Sharing</h1>
          <p className="text-xs text-zinc-500">
            Share your knowledge with a specific user, group, or org. Recipients see
            your shared documents alongside their own in retrieval. Revoke anytime;
            revocation takes effect on the next query.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/sharing/collections"
            className="text-xs px-3 py-1.5 rounded border border-white/10 bg-white/[0.03] text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.06]"
          >
            Collections
          </Link>
          <Link
            href="/sharing/groups"
            className="text-xs px-3 py-1.5 rounded border border-white/10 bg-white/[0.03] text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.06]"
          >
            Groups
          </Link>
          <Link
            href="/sharing/topics"
            className="text-xs px-3 py-1.5 rounded border border-white/10 bg-white/[0.03] text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.06]"
          >
            Topics
          </Link>
          <button
            className="text-xs px-3 py-1.5 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
            onClick={() => setComposerOpen(true)}
          >
            Share knowledge
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-xs text-rose-300 bg-rose-500/10 border border-rose-400/30 rounded px-3 py-2">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : !data ? (
        <div className="text-sm text-zinc-500 italic">No grants yet.</div>
      ) : (
        <div className="space-y-8">
          <PartnersPanel grants={data.grants} names={names} />
          <Section
            title="Pending invitations"
            empty="Nothing pending."
            grants={data.pending}
            names={names}
            renderActions={(g) => g.direction === "incoming"
              ? (
                <>
                  <ActionButton label="Accept" onClick={() => onLifecycle(g.id, "accept")} tone="emerald" />
                  <ActionButton label="Decline" onClick={() => onLifecycle(g.id, "decline")} tone="zinc" />
                </>
              )
              : <ActionButton label="Cancel" onClick={() => onLifecycle(g.id, "revoke")} tone="zinc" />
            }
          />
          <Section
            title="Sharing with you"
            empty="No active incoming shares."
            grants={data.incoming}
            names={names}
            renderActions={(g) => (
              <ActionButton label="Stop receiving" onClick={() => onLifecycle(g.id, "revoke")} tone="zinc" />
            )}
          />
          <Section
            title="You are sharing"
            empty="No active outgoing shares."
            grants={data.outgoing}
            names={names}
            renderActions={(g) => (
              <ActionButton label="Revoke" onClick={() => onLifecycle(g.id, "revoke")} tone="rose" />
            )}
          />
        </div>
      )}

      {composerOpen && (
        <Composer
          onClose={() => setComposerOpen(false)}
          onCreated={() => { setComposerOpen(false); reload(); }}
          initialScope={initialScope}
        />
      )}
    </div>
  );
}

export default function SharingPage() {
  return (
    <Suspense fallback={<div className="px-6 py-8 text-sm text-zinc-500">Loading…</div>}>
      <SharingPageInner />
    </Suspense>
  );
}

function Section({
  title,
  empty,
  grants,
  names,
  renderActions,
}: {
  title: string;
  empty: string;
  grants: Grant[];
  names: Record<string, ReturnType<typeof usePrincipalNames>[string]>;
  renderActions: (g: Grant) => React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">{title}</h2>
      {grants.length === 0 ? (
        <div className="text-xs text-zinc-600 italic">{empty}</div>
      ) : (
        <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden bg-white/[0.02]">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-100">
                  <Principal type={g.granter_type} id={g.granter_id} info={names[`${g.granter_type}:${g.granter_id}`]} />
                  <span className="text-zinc-500"> → </span>
                  <Principal type={g.target_type} id={g.target_id} info={names[`${g.target_type}:${g.target_id}`]} />
                </div>
                <div className="text-[11px] text-zinc-500 mt-1">
                  scope: {g.scope_type === "all" ? "all knowledge" : `${g.scope_type}:${g.scope_ref}`}
                  <span className="mx-2">·</span>
                  status: <span className={statusTint(g.status)}>{g.status}</span>
                  <span className="mx-2">·</span>
                  created {fmtRel(g.created_at)}
                  {g.expires_at && <><span className="mx-2">·</span>expires {fmtRel(g.expires_at)}</>}
                </div>
              </div>
              <div className="flex gap-2 ml-3">{renderActions(g)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PartnersPanel({
  grants,
  names,
}: {
  grants: Grant[];
  names: Record<string, ReturnType<typeof usePrincipalNames>[string]>;
}) {
  // Active org→org grants — both directions. Surfaces "partner organizations"
  // independently of the per-user lanes (which mix user and org grants).
  const partners = grants.filter(
    (g) => g.status === "active" && g.granter_type === "org" && g.target_type === "org",
  );
  if (partners.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Partner organizations</h2>
      <ul className="divide-y divide-white/5 border border-violet-400/15 rounded-lg overflow-hidden bg-violet-500/[0.04]">
        {partners.map((g) => (
          <li key={g.id} className="px-4 py-3 flex items-center justify-between">
            <div className="text-sm text-zinc-100">
              <Principal type="org" id={g.granter_id} info={names[`org:${g.granter_id}`]} />
              <span className="text-zinc-500 mx-2">↔</span>
              <Principal type="org" id={g.target_id} info={names[`org:${g.target_id}`]} />
            </div>
            <div className="text-[10px] text-zinc-500">
              {g.scope_type === "all" ? "org-wide knowledge" : g.scope_type}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Principal({
  type,
  id,
  info,
}: {
  type: PrincipalType;
  id: string;
  info: ReturnType<typeof usePrincipalNames>[string];
}) {
  const label = formatPrincipal({ type, id }, info);
  const tagClass =
    type === "user"  ? "text-cyan-400"
    : type === "org" ? "text-violet-400"
    :                   "text-amber-400";
  return (
    <span className="text-zinc-100">
      <span className={`text-[10px] mr-1 ${tagClass}`}>{type}</span>
      {label}
    </span>
  );
}

function statusTint(s: Status): string {
  switch (s) {
    case "pending": return "text-amber-300";
    case "active":  return "text-emerald-300";
    case "revoked": return "text-rose-300";
    case "declined":return "text-zinc-400";
    case "expired": return "text-zinc-500";
  }
}

function ActionButton({
  label,
  onClick,
  tone,
}: {
  label: string;
  onClick: () => void;
  tone: "emerald" | "rose" | "zinc";
}) {
  const tint = {
    emerald: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
    rose:    "border-rose-400/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
    zinc:    "border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]",
  }[tone];
  return (
    <button className={`text-[11px] px-2.5 py-1 rounded border ${tint}`} onClick={onClick}>
      {label}
    </button>
  );
}

function Composer({
  onClose,
  onCreated,
  initialScope,
}: {
  onClose: () => void;
  onCreated: () => void;
  // For "Share this document/collection" deep-links from elsewhere in the app.
  initialScope?: { scope_type: ScopeType; scope_ref: string; label?: string };
}) {
  const [granterType, setGranterType] = useState<"user" | "org">("user");
  const [granterOrgId, setGranterOrgId] = useState<string>(""); // active org context for user-granters; required for org-granters
  const [targetType, setTargetType] = useState<PrincipalType>("user");
  const [targetId, setTargetId] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>(initialScope?.scope_type || "all");
  const [scopeRef, setScopeRef] = useState<string>(initialScope?.scope_ref || "");

  const [orgs, setOrgs] = useState<Org[]>([]);
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [o, m, gs, me, cs, ts] = await Promise.all([
        opsFetch<{ organizations: Org[] }>("/api/organizations"),
        opsFetch<{ members: BoardMember[] }>("/api/board-members"),
        opsFetch<{ groups: Group[] }>("/api/sharing/groups"),
        opsFetch<{ org_memberships: OrgMembership[] }>("/api/sharing/me"),
        opsFetch<{ collections: Collection[] }>("/api/sharing/collections"),
        opsFetch<{ topics: Topic[] }>("/api/sharing/topics"),
      ]);
      if (o?.organizations) setOrgs(o.organizations);
      if (m?.members) setMembers(m.members);
      if (gs?.groups) setGroups(gs.groups);
      if (me?.org_memberships) setMemberships(me.org_memberships);
      if (cs?.collections) setCollections(cs.collections);
      if (ts?.topics) setTopics(ts.topics);
    })();
  }, []);

  const adminOrgs = memberships.filter((m) => m.role === "owner" || m.role === "admin");

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    const body: Record<string, unknown> = {
      target_type: targetType,
      target_id: targetId,
      scope_type: scopeType,
      scope_ref: scopeType === "all" ? null : scopeRef,
      granter_type: granterType,
    };
    if (granterType === "org") body.granter_id = granterOrgId;
    else if (granterOrgId) body.granter_org_id = granterOrgId;
    const res = await opsPost<{ grant: Grant }>("/api/sharing/grants", body);
    setSubmitting(false);
    if (!res.ok) setErr(res.error);
    else onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-sm text-zinc-100 font-medium mb-1">Share knowledge</h2>
        <p className="text-[11px] text-zinc-500 mb-4">
          Recipients see the granter&rsquo;s documents in their retrieval. Cross-org and
          org-targeted shares require the receiving side to accept.
        </p>

        {/* GRANTER */}
        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          Share on behalf of
        </label>
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => { setGranterType("user"); setGranterOrgId(""); }}
            className={`text-xs px-3 py-1.5 rounded border ${
              granterType === "user"
                ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Me (my knowledge)
          </button>
          {adminOrgs.length > 0 && (
            <button
              onClick={() => { setGranterType("org"); setGranterOrgId(adminOrgs[0].org_id); }}
              className={`text-xs px-3 py-1.5 rounded border ${
                granterType === "org"
                  ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                  : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
              }`}
              title="Share your organization's org-wide knowledge (admin only)"
            >
              My organization
            </button>
          )}
        </div>

        {granterType === "org" && (
          <select
            value={granterOrgId}
            onChange={(e) => setGranterOrgId(e.target.value)}
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3"
          >
            {adminOrgs.map((m) => (
              <option key={m.org_id} value={m.org_id}>{m.org_name}</option>
            ))}
          </select>
        )}

        {/* SCOPE */}
        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          What
        </label>
        <div className="flex gap-2 mb-3 flex-wrap">
          {(["all", "collection", "topic", "document"] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setScopeType(s); if (s === "all") setScopeRef(""); }}
              className={`text-xs px-3 py-1.5 rounded border ${
                scopeType === s
                  ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                  : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {s === "all" ? "All my knowledge"
               : s === "collection" ? "A collection"
               : s === "topic" ? "A topic"
               : "One document"}
            </button>
          ))}
        </div>

        {scopeType === "collection" && (
          <select
            value={scopeRef}
            onChange={(e) => setScopeRef(e.target.value)}
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3"
          >
            <option value="">Select a collection…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.doc_count} doc{c.doc_count === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        )}
        {scopeType === "document" && (
          <input
            type="text"
            value={scopeRef}
            onChange={(e) => setScopeRef(e.target.value)}
            placeholder="Document UUID (use the share button on a document for one-click)"
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3 font-mono"
          />
        )}
        {scopeType === "topic" && (
          <select
            value={scopeRef}
            onChange={(e) => setScopeRef(e.target.value)}
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200 mb-3"
          >
            <option value="">Select a topic…</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.doc_count} doc{t.doc_count === 1 ? "" : "s"}, {t.wiki_count} wiki)
              </option>
            ))}
          </select>
        )}

        {/* TARGET */}
        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          Share with
        </label>
        <div className="flex gap-2 mb-3">
          {(["user", "org"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTargetType(t); setTargetId(""); }}
              className={`text-xs px-3 py-1.5 rounded border ${
                targetType === t
                  ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                  : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t === "user" ? "Individual user" : "Organization"}
            </button>
          ))}
          {GROUPS_UI_ENABLED && groups.length > 0 && (
            <button
              onClick={() => { setTargetType("group"); setTargetId(""); }}
              className={`text-xs px-3 py-1.5 rounded border ${
                targetType === "group"
                  ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                  : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Group
            </button>
          )}
        </div>

        {targetType === "user" ? (
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200"
          >
            <option value="">Select a board member…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name || m.github_username}
              </option>
            ))}
          </select>
        ) : targetType === "org" ? (
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200"
          >
            <option value="">Select an organization…</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        ) : (
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-full text-sm bg-zinc-950 border border-white/10 rounded px-3 py-2 text-zinc-200"
          >
            <option value="">Select a group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.member_count} member{g.member_count === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        )}

        {err && <div className="mt-3 text-xs text-rose-300">{err}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button
            className="text-xs px-3 py-1.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            disabled={
              !targetId
              || submitting
              || (granterType === "org" && !granterOrgId)
              || (scopeType !== "all" && !scopeRef)
            }
            className="text-xs px-3 py-1.5 rounded border border-violet-400/40 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 disabled:opacity-40"
            onClick={submit}
          >
            {submitting ? "Sharing…" : "Share"}
          </button>
        </div>
      </div>
    </div>
  );
}
