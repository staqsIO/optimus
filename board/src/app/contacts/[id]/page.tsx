"use client";

import { useEffect, useState, useCallback, use, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { opsFetch, opsPost, opsDelete } from "@/lib/ops-api";
import ContactSummary from "@/components/contacts/ContactSummary";
import AskAboutContact from "@/components/contacts/AskAboutContact";
import ConnectionsPanel from "@/components/contacts/ConnectionsPanel";
import TagsPanel from "@/components/contacts/TagsPanel";
import StrengthBadge from "@/components/contacts/StrengthBadge";
import EntityArtifactsSection from "@/components/EntityArtifactsSection";

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

const CHANNEL_COLORS: Record<string, string> = {
  email: "bg-blue-500/10 text-blue-400",
  linkedin: "bg-sky-500/10 text-sky-400",
  phone: "bg-green-500/10 text-green-400",
  slack: "bg-purple-500/10 text-purple-400",
  github: "bg-zinc-500/10 text-zinc-300",
  linear: "bg-indigo-500/10 text-indigo-400",
  telegram: "bg-cyan-500/10 text-cyan-400",
  other: "bg-zinc-500/10 text-zinc-400",
};

const TIER_OPTIONS = ["inner_circle", "active", "inactive", "inbound_only", "newsletter", "automated", "unknown"] as const;
// Mirrors sql/056-rag-participants.sql signal.contacts_contact_type_check.
// "person" was previously listed here but isn't a valid DB value, so picking it
// silently failed the backend's check-constraint validation.
const TYPE_OPTIONS = [
  "cofounder", "board", "investor", "team", "advisor", "customer", "prospect",
  "partner", "vendor", "legal", "accountant", "recruiter", "service",
  "newsletter", "participant", "unknown",
] as const;
const CHANNEL_OPTIONS = ["email", "linkedin", "phone", "slack", "github", "linear", "ashby", "telegram", "other"] as const;
const PLATFORM_OPTIONS = ["github", "shopify", "wordpress", "vercel", "linear", "database", "other"] as const;

interface ContactDetail {
  id: string;
  name: string | null;
  email_address: string | null;
  organization: string | null;
  contact_type: string;
  tier: string | null;
  is_vip: boolean;
  notes: string | null;
  phone: string | null;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  created_at: string;
  relationship_strength: number | null;
  /** OPT-81: set when this contact was soft-merged into another. Present → show Unmerge. */
  merged_into: string | null;
}

interface Identity {
  id: string;
  channel: string;
  identifier: string;
  verified_at: string | null;
  source: string | null;
  created_at: string;
}

interface SplitResult {
  split: boolean;
  source_id: string;
  new_id: string;
  identities_moved: string[];
  source_emails_sent: number;
  new_emails_sent: number;
  error?: string;
}

interface Project {
  id: string;
  project_name: string;
  platform: string;
  locator: string;
  is_primary: boolean;
  platform_config?: Record<string, unknown>;
  created_at: string;
}

interface Signal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  resolved: boolean;
  resolved_at: string | null;
  direction: string;
  domain: string | null;
  created_at: string;
  subject: string | null;
  channel: string | null;
}

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);

  // Editable fields
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editTier, setEditTier] = useState("");
  const [editType, setEditType] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Add identity form
  const [addingIdentity, setAddingIdentity] = useState(false);
  const [newChannel, setNewChannel] = useState("email");
  const [newIdentifier, setNewIdentifier] = useState("");

  // STAQPRO-308 Phase 2 — split identities mode
  const [splitMode, setSplitMode] = useState(false);
  const [selectedSplitIds, setSelectedSplitIds] = useState<Set<string>>(new Set());
  const [splitModalOpen, setSplitModalOpen] = useState(false);
  const [splitName, setSplitName] = useState("");
  const [splitPrimaryEmail, setSplitPrimaryEmail] = useState("");
  const [splitOrg, setSplitOrg] = useState("");
  const [splitType, setSplitType] = useState<string>("unknown");
  const [splitTier, setSplitTier] = useState<string>("active");
  const [splitReason, setSplitReason] = useState("");
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);

  // OPT-81 — unmerge
  const [unmerging, setUnmerging] = useState(false);
  const [unmergeError, setUnmergeError] = useState<string | null>(null);

  const router = useRouter();

  const selectedEmailIdentities = useMemo(
    () => identities.filter((i) => selectedSplitIds.has(i.id) && i.channel === "email"),
    [identities, selectedSplitIds]
  );
  const canOpenSplitModal =
    selectedSplitIds.size > 0 &&
    selectedSplitIds.size < identities.length &&
    selectedEmailIdentities.length > 0;

  // Add project form
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newPlatform, setNewPlatform] = useState("github");
  const [newLocator, setNewLocator] = useState("");

  const load = useCallback(async () => {
    const data = await opsFetch<{
      contact: ContactDetail;
      identities: Identity[];
      projects: Project[];
      signals: Signal[];
    }>(`/api/contacts/${id}`);
    if (data) {
      setContact(data.contact);
      setIdentities(data.identities || []);
      setProjects(data.projects || []);
      setSignals(data.signals || []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit() {
    if (!contact) return;
    setEditName(contact.name || "");
    setEditOrg(contact.organization || "");
    setEditTier(contact.tier || "unknown");
    setEditType(contact.contact_type || "unknown");
    setEditNotes(contact.notes || "");
    setEditing(true);
  }

  async function saveEdit() {
    setSaving(true);
    const result = await opsPost(`/api/contacts/${id}`, {
      name: editName || null,
      organization: editOrg || null,
      contact_type: editType,
      tier: editTier,
      notes: editNotes || null,
    });
    if (result.ok) {
      setEditing(false);
      await load();
    } else {
      setSaveError(result.error);
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!contact) return;
    const label = contact.name?.trim() || contact.email_address;
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Delete contact "${label}"?\n\nThis removes the contact card, identities, and project links.\nEmails, transcripts, and RAG documents that mention them are preserved.`
    );
    if (!ok) return;
    setDeleting(true);
    const result = await opsDelete(`/api/contacts/${id}`);
    if (result.ok) {
      router.push("/contacts");
    } else {
      setSaveError(result.error);
      setDeleting(false);
    }
  }

  async function handleUnmerge() {
    if (!contact) return;
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Unmerge "${contact.name || contact.email_address}"?\n\nThis restores the contact as an independent record and re-points its identities back.`
    );
    if (!ok) return;
    setUnmerging(true);
    setUnmergeError(null);
    const result = await opsPost(`/api/contacts/${id}/unmerge`);
    setUnmerging(false);
    if (result.ok) {
      await load();
    } else {
      setUnmergeError((result as { ok: false; error: string }).error ?? "Unmerge failed");
    }
  }

  async function handleAddIdentity() {
    if (!newIdentifier.trim()) return;
    const result = await opsPost(`/api/contacts/${id}/identities`, {
      channel: newChannel,
      identifier: newIdentifier.trim(),
    });
    if (result.ok) {
      setNewChannel("email");
      setNewIdentifier("");
      setAddingIdentity(false);
      await load();
    }
  }

  function toggleSplitSelection(identityId: string) {
    setSelectedSplitIds((prev) => {
      const next = new Set(prev);
      if (next.has(identityId)) next.delete(identityId);
      else next.add(identityId);
      return next;
    });
  }

  function enterSplitMode() {
    setSplitMode(true);
    setSelectedSplitIds(new Set());
    setAddingIdentity(false);
  }

  function exitSplitMode() {
    setSplitMode(false);
    setSelectedSplitIds(new Set());
    setSplitModalOpen(false);
    setSplitError(null);
  }

  function openSplitModal() {
    if (!canOpenSplitModal) return;
    // Pre-fill primaryEmail with the first selected email identity.
    setSplitPrimaryEmail(selectedEmailIdentities[0]?.identifier ?? "");
    setSplitName("");
    setSplitOrg("");
    setSplitType("unknown");
    setSplitTier("active");
    setSplitReason("");
    setSplitError(null);
    setSplitModalOpen(true);
  }

  async function submitSplit() {
    if (!splitName.trim() || !splitPrimaryEmail || !splitReason.trim()) return;
    setSplitting(true);
    setSplitError(null);
    const result = await opsPost<SplitResult>(`/api/contacts/${id}/split-identities`, {
      identityIds: Array.from(selectedSplitIds),
      newContact: {
        name: splitName.trim(),
        primaryEmail: splitPrimaryEmail,
        organization: splitOrg.trim() || null,
        contactType: splitType,
        tier: splitTier,
      },
      reason: splitReason.trim(),
    });
    setSplitting(false);
    if (!result.ok) {
      setSplitError(result.error);
      return;
    }
    // Handler returns { error } on validation failure (HTTP 200, but error field set).
    if (result.data.error) {
      setSplitError(result.data.error);
      return;
    }
    if (result.data.new_id) {
      router.push(`/contacts/${result.data.new_id}`);
      return;
    }
    setSplitError("Unexpected response from server");
  }

  async function handleAddProject() {
    if (!newProjectName.trim() || !newLocator.trim()) return;
    const result = await opsPost(`/api/contacts/${id}/projects`, {
      project_name: newProjectName.trim(),
      platform: newPlatform,
      locator: newLocator.trim(),
    });
    if (result.ok) {
      setNewProjectName("");
      setNewPlatform("github");
      setNewLocator("");
      setAddingProject(false);
      await load();
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading contact...</div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Contact not found</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Link href="/contacts" className="hover:text-zinc-300 transition-colors">Contacts</Link>
          <span>/</span>
          <span className="text-zinc-300">{contact.name || contact.email_address || contact.id.slice(0, 8)}</span>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              {editing ? (
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-2xl font-bold bg-zinc-800 border border-white/10 rounded-lg px-3 py-1 text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                />
              ) : (
                <h1 className="text-2xl font-bold tracking-tight">{contact.name || "Unnamed Contact"}</h1>
              )}
              {contact.is_vip && (
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  VIP
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${TIER_COLORS[contact.tier ?? "unknown"] || TIER_COLORS.unknown}`}>
                {contact.tier ? contact.tier.replace("_", " ") : "unknown"}
              </span>
              {contact.contact_type && contact.contact_type !== "unknown" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
                  {contact.contact_type}
                </span>
              )}
              {contact.organization && (
                <span className="text-xs text-zinc-500">{contact.organization}</span>
              )}
              <StrengthBadge contactId={contact.id} />
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {!editing ? (
              <>
                <button
                  onClick={startEdit}
                  className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1.5 text-xs bg-red-900/40 text-red-300 border border-red-800/40 rounded hover:bg-red-900/60 disabled:opacity-50 transition-colors"
                  title="Permanently delete this contact card. Emails and RAG documents are preserved."
                >
                  {deleting ? "Deleting..." : "Delete"}
                </button>
                {contact.merged_into && (
                  <button
                    onClick={handleUnmerge}
                    disabled={unmerging}
                    className="px-3 py-1.5 text-xs bg-amber-900/30 text-amber-300 border border-amber-700/40 rounded hover:bg-amber-900/50 disabled:opacity-50 transition-colors"
                    title="Reverse the auto-merge — restores this contact as an independent record."
                  >
                    {unmerging ? "Unmerging…" : "Unmerge"}
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  onClick={saveEdit}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white rounded transition-colors"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => { setEditing(false); setSaveError(null); }}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* OPT-81: merged-into banner + unmerge error */}
        {contact.merged_into && (
          <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 px-4 py-3 flex items-center gap-3 text-xs text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
            <span>
              This contact was auto-merged into{" "}
              <Link href={`/contacts/${contact.merged_into}`} className="underline hover:text-amber-300 transition-colors">
                the canonical record
              </Link>
              . Use the Unmerge button to reverse if this was incorrect.
            </span>
          </div>
        )}
        {unmergeError && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2 text-xs text-red-400">
            {unmergeError}
          </div>
        )}

        {/* Snapshot — synthesized RAG summary scoped to this contact */}
        <ContactSummary
          contactId={contact.id}
          contactName={contact.name || contact.email_address || "this contact"}
        />

        {/* Ask box — scoped follow-up questions */}
        <AskAboutContact
          contactId={contact.id}
          contactName={contact.name || contact.email_address || "this contact"}
        />

        {/* Graph-derived relationships (Phase 2 inferrer output) */}
        <ConnectionsPanel contactId={contact.id} />

        {/* Free-form tags (Phase 4) */}
        <TagsPanel contactId={contact.id} />

        {/* Info Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: editable fields */}
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 space-y-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-2">Details</h3>
            {saveError && (
              <div className="mb-3 px-3 py-2 text-xs bg-red-950/40 border border-red-900/50 text-red-300 rounded">
                {saveError}
              </div>
            )}
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Organization</label>
                  <input
                    value={editOrg}
                    onChange={(e) => setEditOrg(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Tier</label>
                  <select
                    value={editTier}
                    onChange={(e) => setEditTier(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                  >
                    {TIER_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t.replace("_", " ")}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Type</label>
                  <select
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Notes</label>
                  <textarea
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    rows={3}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 resize-y"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Organization</span>
                  <span className="text-zinc-200">{contact.organization || "--"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Email</span>
                  <span className="text-zinc-200">{contact.email_address || "--"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Phone</span>
                  <span className="text-zinc-200">{contact.phone || "--"}</span>
                </div>
                {contact.notes && (
                  <div className="pt-2 border-t border-white/5">
                    <span className="text-zinc-500 text-xs block mb-1">Notes</span>
                    <p className="text-zinc-300 text-xs whitespace-pre-wrap">{contact.notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: stats */}
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 space-y-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-2">Stats</h3>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Emails Received" value={String(contact.emails_received || 0)} />
              <StatCard label="Emails Sent" value={String(contact.emails_sent || 0)} />
              <StatCard
                label="Last Received"
                value={contact.last_received_at ? new Date(contact.last_received_at).toLocaleDateString() : "Never"}
              />
              <StatCard
                label="Relationship"
                // STAQPRO-326 follow-up: relationship_strength is already a
                // 0–100 integer from lib/graph/relationship-strength.js
                // (Math.min(100, raw)). The previous *100 multiplier turned
                // a healthy score of 50 into "5000%" on the contact page.
                value={contact.relationship_strength != null ? `${Math.round(contact.relationship_strength)}%` : "N/A"}
              />
            </div>
          </div>
        </div>

        {/* Identities */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Identities</h3>
            <div className="flex items-center gap-2">
              {!splitMode && !addingIdentity && (
                <button
                  onClick={() => setAddingIdentity(true)}
                  className="px-2.5 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
                >
                  + Identity
                </button>
              )}
              {!splitMode && !addingIdentity && identities.length > 1 && (
                <button
                  onClick={enterSplitMode}
                  title="Move some identities to a brand-new contact (undo a bad merge)"
                  className="px-2.5 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
                >
                  Split…
                </button>
              )}
              {splitMode && (
                <button
                  onClick={exitSplitMode}
                  className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Cancel split
                </button>
              )}
            </div>
          </div>
          <div className="p-4 space-y-2">
            {identities.length === 0 && !addingIdentity && (
              <p className="text-xs text-zinc-500">No identities linked yet.</p>
            )}
            {identities.map((identity) => (
              <div key={identity.id} className="flex items-center gap-3 text-sm">
                {splitMode && (
                  <input
                    type="checkbox"
                    checked={selectedSplitIds.has(identity.id)}
                    onChange={() => toggleSplitSelection(identity.id)}
                    className="accent-amber-400"
                    aria-label={`Select identity ${identity.identifier} for split`}
                  />
                )}
                <span className={`text-[10px] px-2 py-0.5 rounded ${CHANNEL_COLORS[identity.channel] || CHANNEL_COLORS.other}`}>
                  {identity.channel}
                </span>
                <span className="text-zinc-200">{identity.identifier}</span>
                {identity.verified_at && (
                  <span className="text-[10px] text-emerald-400">verified</span>
                )}
                {identity.source && (
                  <span className="text-[10px] text-zinc-600">{identity.source}</span>
                )}
              </div>
            ))}
            {splitMode && (
              <div className="pt-3 mt-2 border-t border-white/5 flex items-center justify-between text-xs">
                <span className="text-zinc-500">
                  {selectedSplitIds.size === 0 && "Pick the identities that belong to a different person."}
                  {selectedSplitIds.size > 0 && selectedSplitIds.size >= identities.length && (
                    <span className="text-amber-400">Selecting all would orphan the source — leave at least one behind.</span>
                  )}
                  {selectedSplitIds.size > 0 && selectedSplitIds.size < identities.length && selectedEmailIdentities.length === 0 && (
                    <span className="text-amber-400">Selection needs at least one email identity to become the new contact&apos;s primary.</span>
                  )}
                  {canOpenSplitModal && (
                    <span className="text-zinc-400">
                      {selectedSplitIds.size} selected, {identities.length - selectedSplitIds.size} stay on this contact.
                    </span>
                  )}
                </span>
                <button
                  onClick={openSplitModal}
                  disabled={!canOpenSplitModal}
                  className="px-3 py-1.5 text-xs rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Split {selectedSplitIds.size} →
                </button>
              </div>
            )}
            {addingIdentity && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/5">
                <select
                  value={newChannel}
                  onChange={(e) => setNewChannel(e.target.value)}
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright"
                >
                  {CHANNEL_OPTIONS.map((ch) => (
                    <option key={ch} value={ch}>{ch}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newIdentifier}
                  onChange={(e) => setNewIdentifier(e.target.value)}
                  placeholder="Identifier..."
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddIdentity();
                    if (e.key === "Escape") { setAddingIdentity(false); setNewIdentifier(""); }
                  }}
                />
                <button
                  onClick={handleAddIdentity}
                  className="px-2.5 py-1 text-xs rounded bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 transition-colors"
                >
                  Add
                </button>
                <button
                  onClick={() => { setAddingIdentity(false); setNewIdentifier(""); }}
                  className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Projects */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Projects</h3>
            {!addingProject && (
              <button
                onClick={() => setAddingProject(true)}
                className="px-2.5 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
              >
                + Project
              </button>
            )}
          </div>
          <div className="p-4 space-y-2">
            {projects.length === 0 && !addingProject && (
              <p className="text-xs text-zinc-500">No projects linked yet.</p>
            )}
            {projects.map((project) => (
              <div key={project.id} className="flex items-center gap-3 text-sm">
                <span className={`text-[10px] px-2 py-0.5 rounded ${PLATFORM_COLORS[project.platform] || PLATFORM_COLORS.other}`}>
                  {project.platform}
                </span>
                <span className="text-zinc-200 font-medium">{project.project_name}</span>
                <span className="text-zinc-500 text-xs">{project.locator}</span>
                {project.is_primary && (
                  <span className="text-[10px] text-emerald-400">primary</span>
                )}
              </div>
            ))}
            {addingProject && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/5">
                <select
                  value={newPlatform}
                  onChange={(e) => setNewPlatform(e.target.value)}
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright"
                >
                  {PLATFORM_OPTIONS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Project name..."
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[160px]"
                />
                <input
                  type="text"
                  value={newLocator}
                  onChange={(e) => setNewLocator(e.target.value)}
                  placeholder="Locator (URL/slug)..."
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[200px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddProject();
                    if (e.key === "Escape") { setAddingProject(false); setNewProjectName(""); setNewLocator(""); }
                  }}
                />
                <button
                  onClick={handleAddProject}
                  className="px-2.5 py-1 text-xs rounded bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 transition-colors"
                >
                  Add
                </button>
                <button
                  onClick={() => { setAddingProject(false); setNewProjectName(""); setNewLocator(""); }}
                  className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Recent Signals */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <h3 className="text-sm font-medium text-zinc-300">Recent Signals</h3>
          </div>
          {signals.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">No signals found for this contact.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-white/5">
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-4 py-2 font-medium">Content</th>
                    <th className="text-left px-4 py-2 font-medium">Subject</th>
                    <th className="text-left px-4 py-2 font-medium">Date</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {signals.map((signal) => (
                    <tr key={signal.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                          {signal.signal_type}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-zinc-300 max-w-xs truncate">
                        {signal.content}
                      </td>
                      <td className="px-4 py-2 text-zinc-500 max-w-[200px] truncate">
                        {signal.subject || "--"}
                      </td>
                      <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">
                        {new Date(signal.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">
                        {signal.resolved ? (
                          <span className="text-emerald-400">resolved</span>
                        ) : (
                          <span className="text-zinc-500">open</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Artifacts (OPT-94 PR B) */}
        <EntityArtifactsSection entityType="contact" entityId={id} />

        {/* Split identities modal (STAQPRO-308 Phase 2) */}
        {splitModalOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="split-modal-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => !splitting && setSplitModalOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-zinc-900 border border-white/10 rounded-lg w-full max-w-md p-5 space-y-4"
            >
              <h3 id="split-modal-title" className="text-sm font-medium text-zinc-200">
                Split {selectedSplitIds.size} {selectedSplitIds.size === 1 ? "identity" : "identities"} into a new contact
              </h3>
              <p className="text-xs text-zinc-500">
                Use this to undo a wrong-person merge. The selected identities move to a brand-new contact; this contact keeps the rest. <code className="text-zinc-400">emails_sent</code> is recomputed from sent-mail ground truth.
              </p>

              <label className="block text-xs">
                <span className="text-zinc-400">Name *</span>
                <input
                  type="text"
                  value={splitName}
                  onChange={(e) => setSplitName(e.target.value)}
                  placeholder="e.g. Jordan Rivera"
                  className="mt-1 w-full px-2 py-1.5 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright"
                />
              </label>

              <fieldset className="text-xs">
                <legend className="text-zinc-400">Primary email *</legend>
                <div className="mt-1 space-y-1">
                  {selectedEmailIdentities.map((i) => (
                    <label key={i.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="split-primary-email"
                        value={i.identifier}
                        checked={splitPrimaryEmail === i.identifier}
                        onChange={() => setSplitPrimaryEmail(i.identifier)}
                        className="accent-amber-400"
                      />
                      <span className="text-zinc-200">{i.identifier}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="text-zinc-400">Organization</span>
                  <input
                    type="text"
                    value={splitOrg}
                    onChange={(e) => setSplitOrg(e.target.value)}
                    placeholder="optional"
                    className="mt-1 w-full px-2 py-1.5 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright"
                  />
                </label>
                <label className="block text-xs">
                  <span className="text-zinc-400">Tier</span>
                  <select
                    value={splitTier}
                    onChange={(e) => setSplitTier(e.target.value)}
                    className="mt-1 w-full px-2 py-1.5 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-accent-bright"
                  >
                    {TIER_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block text-xs">
                <span className="text-zinc-400">Reason * <span className="text-zinc-600">(audited)</span></span>
                <input
                  type="text"
                  value={splitReason}
                  onChange={(e) => setSplitReason(e.target.value)}
                  placeholder="e.g. undo wrong-person merge"
                  className="mt-1 w-full px-2 py-1.5 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright"
                />
              </label>

              {splitError && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
                  {splitError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setSplitModalOpen(false)}
                  disabled={splitting}
                  className="px-3 py-1.5 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submitSplit}
                  disabled={
                    splitting ||
                    !splitName.trim() ||
                    !splitPrimaryEmail ||
                    !splitReason.trim()
                  }
                  className="px-3 py-1.5 text-xs rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  {splitting ? "Splitting…" : "Split"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-800/50 border border-white/5 rounded-lg p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-sm font-medium text-zinc-200">{value}</div>
    </div>
  );
}
