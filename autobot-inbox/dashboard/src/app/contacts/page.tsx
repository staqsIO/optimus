"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { timeAgo } from "@/components/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

interface Contact {
  id: string;
  email_address: string;
  name: string | null;
  contact_type: string | null;
  is_vip: boolean;
  phone: string | null;
  default_repos: string[] | null;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  created_at: string;
}

interface GitHubRepo {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  updated_at: string;
}

interface ContactProject {
  id: string;
  contact_id: string;
  project_name: string;
  platform: string;
  locator: string;
  platform_config: Record<string, unknown>;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
}

interface ContactSignal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  resolved: boolean;
  resolved_at: string | null;
  direction: string | null;
  domain: string | null;
  created_at: string;
  subject: string | null;
  channel: string;
}

interface DetailData {
  contact: Contact & {
    relationship_strength: number | null;
    organization: string | null;
    notes: string | null;
    vip_reason: string | null;
    tier: string | null;
    last_sent_at: string | null;
    avg_response_time_hours: number | null;
  };
  projects: ContactProject[];
  signals: ContactSignal[];
}

const CONTACT_TYPES = [
  "cofounder", "board", "investor", "team", "advisor", "customer",
  "prospect", "partner", "vendor", "legal", "accountant", "recruiter",
  "service", "newsletter", "unknown",
];

const PLATFORM_COLORS: Record<string, string> = {
  github: "bg-zinc-700/50 text-zinc-300",
  shopify: "bg-green-500/20 text-green-300",
  wordpress: "bg-blue-500/20 text-blue-300",
  vercel: "bg-zinc-600/50 text-zinc-300",
  database: "bg-amber-500/20 text-amber-300",
};

const PLATFORM_LABELS: Record<string, string> = {
  github: "GH",
  shopify: "SH",
  wordpress: "WP",
  vercel: "VR",
  database: "DB",
};

const PLATFORM_PLACEHOLDERS: Record<string, string> = {
  github: "owner/repo",
  shopify: "store.myshopify.com",
  wordpress: "https://example.com",
  vercel: "prj_xxxxxxxxxx",
  database: "schema/table",
};

const SIGNAL_COLORS: Record<string, string> = {
  commitment: "bg-red-500/20 text-red-300",
  deadline: "bg-orange-500/20 text-orange-300",
  request: "bg-blue-500/20 text-blue-300",
  question: "bg-purple-500/20 text-purple-300",
  approval_needed: "bg-yellow-500/20 text-yellow-300",
  decision: "bg-cyan-500/20 text-cyan-300",
  introduction: "bg-emerald-500/20 text-emerald-300",
  info: "bg-zinc-500/20 text-zinc-300",
  action_item: "bg-rose-500/20 text-rose-300",
};

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactEdits, setContactEdits] = useState<Record<string, Partial<Contact & { organization?: string | null; notes?: string | null; vip_reason?: string | null }>>>({});
  const [contactSaving, setContactSaving] = useState<string | null>(null);
  const [availableRepos, setAvailableRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);

  // Search & filter state
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterVip, setFilterVip] = useState<"all" | "vip" | "non-vip">("all");

  // Repo picker search (per-contact)
  const [repoSearch, setRepoSearch] = useState<Record<string, string>>({});
  const [repoDropdownOpen, setRepoDropdownOpen] = useState<string | null>(null);

  // Detail panel state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Add project form state
  const [addProjectForm, setAddProjectForm] = useState<{ platform: string; locator: string } | null>(null);
  const [addProjectSaving, setAddProjectSaving] = useState(false);

  // Notes auto-save timer
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    fetch(`${API_URL}/api/contacts`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => { setContacts(data.contacts || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    fetch(`${API_URL}/api/github/repos`, { signal: AbortSignal.timeout(15000) })
      .then((r) => r.json())
      .then((data) => setAvailableRepos(data.repos || []))
      .catch(() => {});
  }, [refresh]);

  const fetchDetail = useCallback(async (contactId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/contacts/${contactId}`, {
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!data.error) {
        setDetailData(data);
      }
    } catch {}
    setDetailLoading(false);
  }, []);

  const toggleExpand = useCallback((contactId: string) => {
    if (expandedId === contactId) {
      setExpandedId(null);
      setDetailData(null);
      setAddProjectForm(null);
    } else {
      setExpandedId(contactId);
      setAddProjectForm(null);
      fetchDetail(contactId);
    }
  }, [expandedId, fetchDetail]);

  // Filtered contacts
  const filtered = useMemo(() => {
    let result = contacts;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) =>
        (c.name || "").toLowerCase().includes(q) ||
        c.email_address.toLowerCase().includes(q) ||
        (c.phone || "").includes(q)
      );
    }
    if (filterType !== "all") {
      result = result.filter((c) => (c.contact_type || "unknown") === filterType);
    }
    if (filterVip === "vip") {
      result = result.filter((c) => c.is_vip);
    } else if (filterVip === "non-vip") {
      result = result.filter((c) => !c.is_vip);
    }
    return result;
  }, [contacts, search, filterType, filterVip]);

  // Stats
  const vipCount = contacts.filter((c) => c.is_vip).length;
  const typeBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    contacts.forEach((c) => { map[c.contact_type || "unknown"] = (map[c.contact_type || "unknown"] || 0) + 1; });
    return map;
  }, [contacts]);

  const saveContact = async (contactId: string) => {
    const edits = contactEdits[contactId];
    if (!edits) return;
    setContactSaving(contactId);
    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `/api/contacts/${contactId}`, body: edits }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setContactEdits((prev) => {
          const next = { ...prev };
          delete next[contactId];
          return next;
        });
        refresh();
        if (expandedId === contactId) fetchDetail(contactId);
      }
    } catch {}
    setContactSaving(null);
  };

  const saveNotesDebounced = useCallback((contactId: string, notes: string) => {
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(async () => {
      try {
        await fetch("/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `/api/contacts/${contactId}`, body: { notes } }),
        });
      } catch {}
    }, 1500);
  }, []);

  const addProject = async (contactId: string) => {
    if (!addProjectForm?.platform || !addProjectForm?.locator) return;
    setAddProjectSaving(true);
    try {
      const projectName = addProjectForm.platform === "github"
        ? addProjectForm.locator.split("/").pop() || addProjectForm.locator
        : addProjectForm.locator.replace(/^https?:\/\//, "").split(".")[0] || addProjectForm.locator;
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/contacts/${contactId}/projects`,
          body: {
            project_name: projectName,
            platform: addProjectForm.platform,
            locator: addProjectForm.locator,
          },
        }),
      });
      setAddProjectForm(null);
      fetchDetail(contactId);
    } catch {}
    setAddProjectSaving(false);
  };

  const removeProject = async (contactId: string, projectId: string) => {
    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/contacts/${contactId}/projects/remove`,
          body: { projectId },
        }),
      });
      fetchDetail(contactId);
    } catch {}
  };

  const toggleContactRepo = (contactId: string, repoFullName: string) => {
    const contact = contacts.find((c) => c.id === contactId);
    const currentEdits = contactEdits[contactId] || {};
    const currentRepos = currentEdits.default_repos ?? contact?.default_repos ?? [];
    const has = currentRepos.includes(repoFullName);
    const nextRepos = has
      ? currentRepos.filter((r: string) => r !== repoFullName)
      : [...currentRepos, repoFullName];
    setContactEdits((prev) => ({
      ...prev,
      [contactId]: { ...prev[contactId], default_repos: nextRepos },
    }));
  };

  // Filtered repos for a contact's repo picker
  const getFilteredRepos = (contactId: string, currentRepos: string[]) => {
    const q = (repoSearch[contactId] || "").toLowerCase();
    return availableRepos
      .filter((r) => !currentRepos.includes(r.full_name))
      .filter((r) => !q || r.full_name.toLowerCase().includes(q));
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Contacts</h1>
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {contacts.length} contacts{vipCount > 0 && ` \u00b7 ${vipCount} VIP`}
          </p>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, or phone..."
            className="w-full rounded-md bg-surface-overlay border border-white/10 pl-10 pr-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white text-xs"
            >
              Clear
            </button>
          )}
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
        >
          <option value="all">All Types</option>
          {CONTACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t} {typeBreakdown[t] ? `(${typeBreakdown[t]})` : ""}
            </option>
          ))}
        </select>
        <select
          value={filterVip}
          onChange={(e) => setFilterVip(e.target.value as "all" | "vip" | "non-vip")}
          className="rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
        >
          <option value="all">All</option>
          <option value="vip">VIP Only</option>
          <option value="non-vip">Non-VIP</option>
        </select>
        <span className="text-xs text-zinc-500">
          {filtered.length !== contacts.length && `${filtered.length} of `}{contacts.length} contacts
        </span>
      </div>

      {/* Contact List */}
      {filtered.length > 0 ? (
        <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1.5fr_130px_50px_1fr_130px_60px] gap-3 px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-medium border-b border-white/5">
            <span>Contact</span>
            <span>Type</span>
            <span>VIP</span>
            <span>Default Repos</span>
            <span>Phone</span>
            <span></span>
          </div>

          <div className="divide-y divide-white/5">
            {filtered.map((contact) => {
              const edits = contactEdits[contact.id] || {};
              const hasEdits = Object.keys(edits).length > 0;
              const currentType = edits.contact_type ?? contact.contact_type ?? "unknown";
              const currentVip = edits.is_vip ?? contact.is_vip;
              const currentPhone = edits.phone ?? contact.phone ?? "";
              const currentRepos = edits.default_repos ?? contact.default_repos ?? [];
              const filteredRepos = getFilteredRepos(contact.id, currentRepos);
              const isExpanded = expandedId === contact.id;

              return (
                <div key={contact.id}>
                  <div
                    className={`grid grid-cols-[1.5fr_130px_50px_1fr_130px_60px] gap-3 items-center px-4 py-3 ${
                      hasEdits ? "bg-accent/5" : isExpanded ? "bg-white/[0.03]" : "hover:bg-white/[0.02]"
                    }`}
                  >
                    {/* Name + email — clickable to expand */}
                    <div
                      className="min-w-0 cursor-pointer group"
                      onClick={() => toggleExpand(contact.id)}
                    >
                      <div className="text-sm text-white font-medium truncate flex items-center gap-1.5">
                        <svg
                          className={`w-3 h-3 text-zinc-500 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        {currentVip && (
                          <span className="text-amber-400 text-xs" title="VIP">&#9733;</span>
                        )}
                        <span className="group-hover:text-accent-bright transition-colors">
                          {contact.name || contact.email_address}
                        </span>
                      </div>
                      <div className="text-[10px] text-zinc-500 truncate pl-[18px]">
                        {contact.email_address}
                        {contact.emails_received > 0 && (
                          <span className="ml-1.5 text-zinc-600">{contact.emails_received} recv / {contact.emails_sent} sent</span>
                        )}
                      </div>
                    </div>

                    {/* Type dropdown */}
                    <select
                      value={currentType}
                      onChange={(e) =>
                        setContactEdits((prev) => ({
                          ...prev,
                          [contact.id]: { ...prev[contact.id], contact_type: e.target.value },
                        }))
                      }
                      className="rounded bg-surface-overlay border border-white/10 px-2 py-1 text-xs text-white focus:border-accent focus:outline-none"
                    >
                      {CONTACT_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>

                    {/* VIP toggle */}
                    <label className="flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={currentVip}
                        onChange={(e) =>
                          setContactEdits((prev) => ({
                            ...prev,
                            [contact.id]: { ...prev[contact.id], is_vip: e.target.checked },
                          }))
                        }
                        className="rounded border-white/20 bg-surface-overlay text-accent focus:ring-accent/30 h-3.5 w-3.5"
                      />
                    </label>

                    {/* Repos — searchable multi-select */}
                    <div className="min-w-0 relative">
                      <div className="flex flex-wrap gap-1 items-center">
                        {currentRepos.map((r) => (
                          <span
                            key={r}
                            className="text-[10px] bg-accent/10 text-accent-bright px-1.5 py-0.5 rounded cursor-pointer hover:bg-red-500/20 hover:text-red-300 transition-colors inline-flex items-center gap-0.5"
                            onClick={() => toggleContactRepo(contact.id, r)}
                            title="Click to remove"
                          >
                            {r.split("/")[1] || r}
                            <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </span>
                        ))}
                        {availableRepos.length > 0 && (
                          <div className="relative inline-block">
                            <button
                              onClick={() => setRepoDropdownOpen(repoDropdownOpen === contact.id ? null : contact.id)}
                              className="text-[10px] bg-surface-overlay border border-white/10 rounded px-1.5 py-0.5 text-zinc-400 hover:text-white hover:border-accent/30 transition-colors"
                            >
                              + repo
                            </button>
                            {repoDropdownOpen === contact.id && (
                              <div className="absolute top-full left-0 mt-1 z-50 w-72 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden">
                                <div className="p-2 border-b border-white/5">
                                  <input
                                    type="text"
                                    value={repoSearch[contact.id] || ""}
                                    onChange={(e) => setRepoSearch((prev) => ({ ...prev, [contact.id]: e.target.value }))}
                                    placeholder="Search repos..."
                                    autoFocus
                                    className="w-full rounded bg-surface-overlay border border-white/10 px-2 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
                                  />
                                </div>
                                <div className="max-h-48 overflow-y-auto">
                                  {filteredRepos.length > 0 ? (
                                    filteredRepos.map((r) => (
                                      <button
                                        key={r.full_name}
                                        onClick={() => {
                                          toggleContactRepo(contact.id, r.full_name);
                                          setRepoDropdownOpen(null);
                                          setRepoSearch((prev) => ({ ...prev, [contact.id]: "" }));
                                        }}
                                        className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-white/5 hover:text-white flex items-center justify-between"
                                      >
                                        <span className="truncate">{r.full_name}</span>
                                        {r.private && (
                                          <span className="text-[9px] text-zinc-500 ml-2 shrink-0">private</span>
                                        )}
                                      </button>
                                    ))
                                  ) : (
                                    <div className="px-3 py-2 text-xs text-zinc-500">No repos found</div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Phone */}
                    <input
                      type="text"
                      value={currentPhone}
                      onChange={(e) =>
                        setContactEdits((prev) => ({
                          ...prev,
                          [contact.id]: { ...prev[contact.id], phone: e.target.value || null },
                        }))
                      }
                      placeholder="+1..."
                      className="rounded bg-surface-overlay border border-white/10 px-2 py-1 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none font-mono"
                    />

                    {/* Save button */}
                    <button
                      onClick={() => saveContact(contact.id)}
                      disabled={!hasEdits || contactSaving === contact.id}
                      className="rounded bg-accent px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-20"
                    >
                      {contactSaving === contact.id ? "..." : "Save"}
                    </button>
                  </div>

                  {/* Expanded Detail Panel */}
                  {isExpanded && (
                    <div className="border-t border-white/5 animate-fade-in bg-white/[0.01]">
                      {detailLoading ? (
                        <div className="px-6 py-8 text-center text-zinc-500 text-sm">Loading contact details...</div>
                      ) : detailData ? (
                        <div className="grid grid-cols-2 gap-0 divide-x divide-white/5">
                          {/* LEFT COLUMN */}
                          <div className="divide-y divide-white/5">
                            {/* Contact Info */}
                            <div className="px-5 py-4 space-y-3">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Contact Info</div>
                              <div className="flex flex-wrap gap-2">
                                {detailData.contact.contact_type && (
                                  <span className="text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent-bright">
                                    {detailData.contact.contact_type}
                                  </span>
                                )}
                                {detailData.contact.tier && detailData.contact.tier !== "unknown" && (
                                  <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-700/50 text-zinc-300">
                                    {detailData.contact.tier.replace("_", " ")}
                                  </span>
                                )}
                              </div>
                              {/* Organization */}
                              <div>
                                <label className="text-[10px] text-zinc-500 block mb-1">Organization</label>
                                <input
                                  type="text"
                                  defaultValue={detailData.contact.organization || ""}
                                  onBlur={(e) => {
                                    const val = e.target.value;
                                    if (val !== (detailData.contact.organization || "")) {
                                      setContactEdits((prev) => ({
                                        ...prev,
                                        [contact.id]: { ...prev[contact.id], organization: val || null },
                                      }));
                                    }
                                  }}
                                  placeholder="Company or org..."
                                  className="w-full rounded bg-surface-overlay border border-white/10 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none"
                                />
                              </div>
                              {/* VIP Reason */}
                              {detailData.contact.is_vip && (
                                <div>
                                  <label className="text-[10px] text-zinc-500 block mb-1">VIP Reason</label>
                                  <input
                                    type="text"
                                    defaultValue={detailData.contact.vip_reason || ""}
                                    onBlur={(e) => {
                                      const val = e.target.value;
                                      if (val !== (detailData.contact.vip_reason || "")) {
                                        setContactEdits((prev) => ({
                                          ...prev,
                                          [contact.id]: { ...prev[contact.id], vip_reason: val || null },
                                        }));
                                      }
                                    }}
                                    placeholder="Why is this contact VIP?"
                                    className="w-full rounded bg-surface-overlay border border-white/10 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none"
                                  />
                                </div>
                              )}
                              {/* Notes */}
                              <div>
                                <label className="text-[10px] text-zinc-500 block mb-1">Notes</label>
                                <textarea
                                  defaultValue={detailData.contact.notes || ""}
                                  onChange={(e) => saveNotesDebounced(contact.id, e.target.value)}
                                  rows={3}
                                  placeholder="Private notes about this contact..."
                                  className="w-full rounded bg-surface-overlay border border-white/10 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none resize-none"
                                />
                              </div>
                            </div>

                            {/* Projects */}
                            <div className="px-5 py-4 space-y-3">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Projects</div>
                              {detailData.projects.length > 0 ? (
                                <div className="space-y-1.5">
                                  {detailData.projects.map((p) => (
                                    <div key={p.id} className="flex items-center gap-2 group">
                                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${PLATFORM_COLORS[p.platform] || "bg-zinc-600/50 text-zinc-300"}`}>
                                        {PLATFORM_LABELS[p.platform] || p.platform.toUpperCase().slice(0, 2)}
                                      </span>
                                      <span className="text-xs text-zinc-300 truncate flex-1" title={p.locator}>
                                        {p.locator}
                                      </span>
                                      {p.is_primary && (
                                        <span className="text-[9px] text-zinc-500">primary</span>
                                      )}
                                      <button
                                        onClick={() => removeProject(contact.id, p.id)}
                                        className="text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                        title="Remove project"
                                      >
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-xs text-zinc-600">No projects linked</div>
                              )}

                              {/* Add project form */}
                              {addProjectForm ? (
                                <div className="flex items-center gap-2">
                                  <select
                                    value={addProjectForm.platform}
                                    onChange={(e) => setAddProjectForm({ ...addProjectForm, platform: e.target.value, locator: "" })}
                                    className="rounded bg-surface-overlay border border-white/10 px-1.5 py-1 text-[10px] text-white focus:border-accent focus:outline-none"
                                  >
                                    {Object.keys(PLATFORM_LABELS).map((p) => (
                                      <option key={p} value={p}>{p}</option>
                                    ))}
                                  </select>
                                  {addProjectForm.platform === "github" && availableRepos.length > 0 ? (
                                    <select
                                      value={addProjectForm.locator}
                                      onChange={(e) => setAddProjectForm({ ...addProjectForm, locator: e.target.value })}
                                      className="flex-1 rounded bg-surface-overlay border border-white/10 px-1.5 py-1 text-[10px] text-white focus:border-accent focus:outline-none"
                                    >
                                      <option value="">Select repo...</option>
                                      {availableRepos.map((r) => (
                                        <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={addProjectForm.locator}
                                      onChange={(e) => setAddProjectForm({ ...addProjectForm, locator: e.target.value })}
                                      placeholder={PLATFORM_PLACEHOLDERS[addProjectForm.platform] || "locator"}
                                      className="flex-1 rounded bg-surface-overlay border border-white/10 px-1.5 py-1 text-[10px] text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none font-mono"
                                    />
                                  )}
                                  <button
                                    onClick={() => addProject(contact.id)}
                                    disabled={!addProjectForm.locator || addProjectSaving}
                                    className="text-[10px] px-2 py-1 rounded bg-accent text-white hover:bg-accent-dim disabled:opacity-30"
                                  >
                                    {addProjectSaving ? "..." : "Add"}
                                  </button>
                                  <button
                                    onClick={() => setAddProjectForm(null)}
                                    className="text-zinc-500 hover:text-white"
                                  >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setAddProjectForm({ platform: "github", locator: "" })}
                                  className="text-[10px] text-zinc-400 hover:text-accent-bright transition-colors"
                                >
                                  + Add Project
                                </button>
                              )}
                            </div>
                          </div>

                          {/* RIGHT COLUMN */}
                          <div className="divide-y divide-white/5">
                            {/* Communication Stats */}
                            <div className="px-5 py-4 space-y-2.5">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Communication</div>
                              <div className="grid grid-cols-2 gap-3 text-xs">
                                <div>
                                  <span className="text-zinc-500">Emails recv:</span>{" "}
                                  <span className="text-white">{detailData.contact.emails_received}</span>
                                  {detailData.contact.last_received_at && (
                                    <span className="text-zinc-600 ml-1">(last: {timeAgo(detailData.contact.last_received_at)})</span>
                                  )}
                                </div>
                                <div>
                                  <span className="text-zinc-500">Emails sent:</span>{" "}
                                  <span className="text-white">{detailData.contact.emails_sent}</span>
                                  {detailData.contact.last_sent_at && (
                                    <span className="text-zinc-600 ml-1">(last: {timeAgo(detailData.contact.last_sent_at)})</span>
                                  )}
                                </div>
                              </div>
                              {detailData.contact.avg_response_time_hours != null && (
                                <div className="text-xs">
                                  <span className="text-zinc-500">Avg response:</span>{" "}
                                  <span className="text-white">
                                    {detailData.contact.avg_response_time_hours < 1
                                      ? `${Math.round(detailData.contact.avg_response_time_hours * 60)}m`
                                      : `${detailData.contact.avg_response_time_hours.toFixed(1)}h`}
                                  </span>
                                </div>
                              )}
                              {/* Relationship strength bar */}
                              {detailData.contact.relationship_strength != null && (
                                <div className="text-xs">
                                  <span className="text-zinc-500">Relationship:</span>{" "}
                                  <div className="inline-flex items-center gap-2 ml-1">
                                    <div className="w-24 h-2 bg-zinc-800 rounded-full overflow-hidden">
                                      <div
                                        className="h-full rounded-full transition-all"
                                        style={{
                                          width: `${detailData.contact.relationship_strength}%`,
                                          backgroundColor: detailData.contact.relationship_strength > 66
                                            ? "#22c55e" : detailData.contact.relationship_strength > 33
                                            ? "#eab308" : "#ef4444",
                                        }}
                                      />
                                    </div>
                                    <span className="text-white">{detailData.contact.relationship_strength}%</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Signals */}
                            <div className="px-5 py-4 space-y-2.5">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                                Recent Signals
                                {detailData.signals.length > 0 && (
                                  <span className="ml-1.5 text-zinc-600">({detailData.signals.length})</span>
                                )}
                              </div>
                              {detailData.signals.length > 0 ? (
                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                  {detailData.signals.map((s) => (
                                    <div key={s.id} className="flex items-start gap-2">
                                      <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${SIGNAL_COLORS[s.signal_type] || "bg-zinc-600/50 text-zinc-300"}`}>
                                        {s.signal_type}
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs text-zinc-300 line-clamp-2">{s.content}</p>
                                        <div className="flex items-center gap-2 mt-0.5">
                                          {s.direction && (
                                            <span className="text-[9px] text-zinc-600">{s.direction}</span>
                                          )}
                                          {s.due_date && (
                                            <span className="text-[9px] text-orange-400">due {timeAgo(s.due_date)}</span>
                                          )}
                                          {s.resolved && (
                                            <span className="text-[9px] text-green-500">resolved</span>
                                          )}
                                          <span className="text-[9px] text-zinc-600">{timeAgo(s.created_at)}</span>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-xs text-zinc-600">No signals extracted yet</div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="px-6 py-8 text-center text-zinc-500 text-sm">Failed to load details</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-surface-raised rounded-lg border border-white/5 p-8 text-center">
          {contacts.length === 0 ? (
            <>
              <p className="text-zinc-400 mb-2">No contacts yet.</p>
              <p className="text-sm text-zinc-500">
                Use &quot;Sync Contacts&quot; on a connected account in{" "}
                <a href="/settings" className="text-accent hover:text-accent-bright">Settings</a>{" "}
                to import from Google Contacts.
              </p>
            </>
          ) : (
            <p className="text-zinc-400">No contacts match your search.</p>
          )}
        </div>
      )}

      <p className="text-xs text-zinc-500">
        Contacts are imported via Google Contacts sync. Assign default repos to route feedback tickets to the right codebase.
      </p>
    </div>
  );
}
