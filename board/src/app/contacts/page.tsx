"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { usePageContext } from "@/contexts/PageContext";
import DuplicatesDrawer, { type DuplicatePair as DrawerDuplicatePair } from "@/components/contacts/DuplicatesDrawer";

// Tier color mapping
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = ms / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  const days = sec / 86400;
  if (days < 30) return `${Math.round(days)}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

const TIER_COLORS: Record<string, string> = {
  inner_circle: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  active: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  inactive: "bg-zinc-700/30 text-zinc-500 border-zinc-700/40",
  inbound_only: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  newsletter: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  automated: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  unknown: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
};

const PLATFORM_COLORS: Record<string, string> = {
  github: "bg-purple-500/10 text-purple-400",
  shopify: "bg-green-500/10 text-green-400",
  wordpress: "bg-blue-500/10 text-blue-400",
  vercel: "bg-zinc-500/10 text-zinc-300",
  linear: "bg-indigo-500/10 text-indigo-400",
  database: "bg-yellow-500/10 text-yellow-400",
  other: "bg-zinc-500/10 text-zinc-400",
};

const CHANNEL_OPTIONS = [
  "email", "linkedin", "phone", "slack", "github", "linear", "ashby", "telegram", "other",
] as const;

const PLATFORM_OPTIONS = [
  "github", "shopify", "wordpress", "vercel", "linear", "database", "other",
] as const;

interface Contact {
  id: string;
  name: string | null;
  email_address: string | null;
  organization: string | null;
  contact_type: string;
  tier: string | null;
  is_vip: boolean;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  identities?: { id: string; channel: string; identifier: string }[];
  projects?: { id: string; project_name: string; platform: string; locator: string; is_primary: boolean }[];
}

interface DuplicatePair {
  id_a: string;
  name_a: string | null;
  email_a: string | null;
  tier_a?: string | null;
  emails_received_a?: number;
  emails_sent_a?: number;
  id_b: string;
  name_b: string | null;
  email_b: string | null;
  tier_b?: string | null;
  emails_received_b?: number;
  emails_sent_b?: number;
  name_sim: number;
  match_reason?: string | null;
}

export default function ContactsPage() {
  const { setCurrentPage } = usePageContext();
  useEffect(() => { setCurrentPage({ route: "/contacts", title: "Contacts" }); return () => setCurrentPage(null); }, [setCurrentPage]);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addingIdentity, setAddingIdentity] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState("email");
  const [newIdentifier, setNewIdentifier] = useState("");
  const [addingProject, setAddingProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newPlatform, setNewPlatform] = useState("github");
  const [newLocator, setNewLocator] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [search, setSearch] = useState("");
  const [hideJunk, setHideJunk] = useState(true);
  const [view, setView] = useState<"compact" | "table">("compact");
  const [githubRepos, setGithubRepos] = useState<{ full_name: string; html_url: string; description?: string }[]>([]);

  // Fetch GitHub repos for the repo picker
  useEffect(() => {
    opsFetch<{ repos: { full_name: string; html_url: string; description?: string }[] }>("/api/github/repos")
      .then((data) => { if (data?.repos) setGithubRepos(data.repos); })
      .catch(() => {});
  }, []);

  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch("/api/ops?path=/api/contacts");
      if (res.ok) {
        const data = await res.json();
        setContacts(data.contacts || data || []);
      }
    } catch {
      // silent
    }
  }, []);

  const fetchDuplicates = useCallback(async () => {
    try {
      const res = await fetch("/api/ops?path=/api/contacts/duplicates");
      if (res.ok) {
        const data = await res.json();
        setDuplicates(data.duplicates || data || []);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchContacts(), fetchDuplicates()]).finally(() => setLoading(false));
  }, [fetchContacts, fetchDuplicates]);


  const handleAddIdentity = async (contactId: string) => {
    if (!newIdentifier.trim()) return;
    try {
      const res = await fetch("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/contacts/${contactId}/identities`,
          body: { channel: newChannel, identifier: newIdentifier.trim() },
        }),
      });
      if (res.ok) {
        setNewChannel("email");
        setNewIdentifier("");
        setAddingIdentity(null);
        await fetchContacts();
      }
    } catch {
      // silent
    }
  };

  const handleAddProject = async (contactId: string) => {
    if (!newProjectName.trim() || !newLocator.trim()) return;
    const result = await opsPost(`/api/contacts/${contactId}/projects`, {
      project_name: newProjectName.trim(),
      platform: newPlatform,
      locator: newLocator.trim(),
    });
    if (result.ok) {
      setNewProjectName("");
      setNewPlatform("github");
      setNewLocator("");
      setAddingProject(null);
      await fetchContacts();
    }
  };

  const handleClassify = async () => {
    setClassifying(true);
    await opsPost("/api/contacts/classify");
    await fetchContacts();
    setClassifying(false);
  };

  // Junk filter — hidden by default; toggle to inspect.
  // Catches: explicit service/newsletter types, mailing-list / opt-out
  // patterns, UUID-named rows, and "participant" contacts that look like
  // tracking infrastructure (no name OR UUID-shaped local-part).
  const isJunk = (c: Contact): boolean => {
    if (c.contact_type === "service" || c.contact_type === "newsletter") return true;
    const email = (c.email_address || "").toLowerCase();
    if (
      /(noreply|no-reply|donotreply|unsubscribe|bounce|notification|notifications|mailer-daemon|postmaster|@unsub\.|customer\.io|@beehiiv|@convertkit-mail\.|@en25\.|@medallia\.|\.fbl\.|\.ngrok\.|spamproc)/.test(
        email,
      )
    )
      return true;
    if (c.name && /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(c.name)) return true;
    if (c.name && /^[0-9a-f]{16,}$/i.test(c.name)) return true;
    // Participant-typed but no name AND a UUID-shaped local-part = tracking
    if (
      c.contact_type === "participant" &&
      !c.name &&
      /[0-9a-f]{8}.*[0-9a-f]{4}/i.test(email.split("@")[0] || "")
    )
      return true;
    // Long random local-parts (>40 chars before @) → tracking blast
    if ((email.split("@")[0] || "").length > 40) return true;
    return false;
  };

  const matchesSearch = (c: Contact, q: string): boolean => {
    if (!q) return true;
    const lower = q.toLowerCase();
    return (
      (c.name && c.name.toLowerCase().includes(lower)) ||
      (c.organization && c.organization.toLowerCase().includes(lower)) ||
      (c.email_address && c.email_address.toLowerCase().includes(lower)) ||
      (c.identities && c.identities.some((id) => id.identifier.toLowerCase().includes(lower))) ||
      false
    );
  };

  const junkCount = contacts.filter(isJunk).length;
  const filtered = contacts
    .filter((c) => (hideJunk ? !isJunk(c) : true))
    .filter((c) => matchesSearch(c, search));

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-40 rounded bg-surface-raised animate-pulse" />
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
        <div className="flex items-center gap-3">
          <div role="radiogroup" aria-label="View" className="flex items-center text-[11px] rounded border border-white/10 overflow-hidden">
            <button
              role="radio"
              aria-checked={view === "compact"}
              onClick={() => setView("compact")}
              className={`px-2 py-1 ${
                view === "compact" ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
              }`}
            >
              Compact
            </button>
            <button
              role="radio"
              aria-checked={view === "table"}
              onClick={() => setView("table")}
              className={`px-2 py-1 ${
                view === "table" ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
              }`}
            >
              Table
            </button>
          </div>
          <button
            onClick={handleClassify}
            disabled={classifying}
            className="px-3 py-1.5 text-xs rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors border border-indigo-500/20 disabled:opacity-50"
          >
            {classifying ? "Classifying..." : "Auto-classify"}
          </button>
          <span className="text-sm text-zinc-400">{contacts.length} total</span>
        </div>
      </div>

      {/* Potential Duplicates — banner opens the review drawer */}
      {duplicates.length > 0 && (
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 text-xs text-amber-400 py-1 select-none hover:text-amber-300 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 motion-safe:animate-pulse flex-shrink-0" />
          <span className="font-semibold">{duplicates.length} potential duplicate{duplicates.length !== 1 ? "s" : ""}</span>
          <span className="text-zinc-600">— click to review</span>
        </button>
      )}

      {/* Duplicates review drawer */}
      <DuplicatesDrawer
        open={drawerOpen}
        pairs={duplicates as DrawerDuplicatePair[]}
        onClose={() => setDrawerOpen(false)}
        onPairsChange={(updated) => setDuplicates(updated as DuplicatePair[])}
        onContactsRefresh={fetchContacts}
      />

      {/* Search + filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts by name, org, or identifier..."
          className="flex-1 max-w-md px-3 py-2 text-sm bg-zinc-900 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-accent-bright"
        />
        <label className="inline-flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideJunk}
            onChange={(e) => setHideJunk(e.target.checked)}
            className="rounded border-white/20 bg-zinc-900"
          />
          Hide non-people
          {junkCount > 0 && (
            <span className="text-[10px] text-zinc-600">({junkCount} hidden)</span>
          )}
        </label>
      </div>

      {/* Contact List */}
      {filtered.length === 0 ? (
        <div className="bg-surface-raised rounded-lg border border-white/5 py-12 text-center">
          <div className="text-zinc-400 text-sm">
            {search ? "No contacts match your search." : "No contacts found."}
          </div>
        </div>
      ) : view === "compact" ? (
        <div className="rounded-lg border border-white/10 divide-y divide-white/5 overflow-hidden">
          {filtered.map((contact) => {
            const primaryIdentity =
              contact.identities?.[0]
                ? `${contact.identities[0].channel}: ${contact.identities[0].identifier}`
                : contact.email_address;
            return (
              <Link
                key={contact.id}
                href={`/contacts/${contact.id}`}
                className="group flex items-center gap-3 px-3 py-2 bg-white/[0.02] hover:bg-white/[0.05] focus-visible:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    contact.is_vip ? "bg-amber-400" : "bg-transparent"
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 truncate">
                    <span className="text-sm font-medium text-zinc-100 truncate">
                      {contact.name || "Unnamed Contact"}
                    </span>
                    {contact.organization && (
                      <span className="text-xs text-zinc-400 truncate shrink-0">
                        {contact.organization}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={`text-[10px] px-1.5 py-px rounded-full border ${
                        TIER_COLORS[contact.tier ?? "unknown"] || TIER_COLORS.unknown
                      }`}
                    >
                      {contact.tier ? contact.tier.replace("_", " ") : "unknown"}
                    </span>
                    {primaryIdentity && (
                      <span className="text-[10px] text-zinc-500 truncate font-mono">
                        {primaryIdentity}
                      </span>
                    )}
                    {contact.identities && contact.identities.length > 1 && (
                      <span className="text-[10px] text-zinc-600 shrink-0">
                        +{contact.identities.length - 1}
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11px] text-zinc-400 tabular-nums">
                  <div>{formatRelative(contact.last_received_at)}</div>
                  <div className="text-zinc-500">
                    ↑{contact.emails_sent ?? 0} ↓{contact.emails_received ?? 0}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-sm table-fixed">
            <thead className="text-[10px] uppercase tracking-wider text-zinc-500 bg-white/[0.02]">
              <tr>
                <th className="text-left px-3 py-2 w-[28%]">Name</th>
                <th className="text-left px-3 py-2 w-[22%]">Organization</th>
                <th className="text-left px-3 py-2 w-[14%]">Tier</th>
                <th className="text-left px-3 py-2 w-[20%]">Email</th>
                <th className="text-right px-3 py-2 w-[8%]">Last</th>
                <th className="text-right px-3 py-2 w-[8%]">In/Out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map((contact) => (
                <tr
                  key={contact.id}
                  className="bg-white/[0.02] hover:bg-white/[0.05] focus-within:bg-white/[0.05]"
                >
                  <td className="px-3 py-1.5 truncate">
                    <Link
                      href={`/contacts/${contact.id}`}
                      className="text-zinc-100 hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      {contact.is_vip && <span className="text-amber-400 mr-1" aria-label="VIP">★</span>}
                      {contact.name || "Unnamed Contact"}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400 truncate">
                    {contact.organization || "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={`text-[10px] px-1.5 py-px rounded-full border ${
                        TIER_COLORS[contact.tier ?? "unknown"] || TIER_COLORS.unknown
                      }`}
                    >
                      {contact.tier ? contact.tier.replace("_", " ") : "unknown"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400 font-mono text-xs truncate">
                    {contact.email_address || "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[11px] text-zinc-400 tabular-nums whitespace-nowrap">
                    {formatRelative(contact.last_received_at)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[11px] text-zinc-500 tabular-nums whitespace-nowrap">
                    ↑{contact.emails_sent ?? 0} ↓{contact.emails_received ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
