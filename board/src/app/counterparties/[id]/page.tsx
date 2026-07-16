"use client";

/**
 * Counterparty detail — rollup view for a single client.
 *
 * Shows identity + contact info, a rollup stats strip, and a list of
 * every contract for this counterparty with status and link back to the
 * contracts page. Editable fields fire PATCH /api/counterparties/:id.
 *
 * This closes one of the follow-ups from the Phase 1–4 build: "you have
 * the entity but no way to see all contracts for Acme." Same internal-UMB
 * scope — board-authenticated, no per-counterparty access scoping.
 */

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { opsFetch, opsPatch } from "@/lib/ops-api";

interface Counterparty {
  id: string;
  name: string;
  domain: string | null;
  primary_signer_name: string | null;
  primary_signer_email: string | null;
  primary_signer_title: string | null;
  address: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ContractRow {
  id: string;
  title: string;
  draft_status: string;
  signing_status: string | null;
  template_id: string | null;
  word_count: number;
  signed_count: number;
  total_signers: number;
  created_at: string;
  updated_at: string;
  cost_usd: string;
}

interface Rollup {
  total: number;
  signed: number;
  out_for_signature: number;
  declined: number;
  drafting: number;
  total_llm_cost_usd: number;
}

const STATUS_PILL: Record<string, string> = {
  draft:       "bg-zinc-600/40 text-zinc-300",
  review:      "bg-blue-500/20 text-blue-300",
  approved:    "bg-amber-500/20 text-amber-300",
  pending:     "bg-violet-500/20 text-violet-300",
  in_progress: "bg-violet-500/20 text-violet-300",
  completed:   "bg-emerald-500/20 text-emerald-300",
  declined:    "bg-red-500/20 text-red-300",
  expired:     "bg-zinc-700/40 text-zinc-500",
  cancelled:   "bg-zinc-700/40 text-zinc-500",
};

function displayStatus(draftStatus: string, signingStatus: string | null): string {
  if (signingStatus === "completed") return "signed";
  if (signingStatus && ["pending", "in_progress", "declined", "expired", "cancelled"].includes(signingStatus)) {
    return signingStatus;
  }
  return draftStatus;
}

export default function CounterpartyPage() {
  const params = useParams();
  const id = params.id as string;

  const [cp, setCp] = useState<Counterparty | null>(null);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Counterparty>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await opsFetch<{
      counterparty: Counterparty;
      contracts: ContractRow[];
      rollup: Rollup;
    }>(`/api/counterparties/${id}`);
    if (!data?.counterparty) {
      setNotFound(true);
    } else {
      setCp(data.counterparty);
      setContracts(data.contracts || []);
      setRollup(data.rollup);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!cp) return;
    setSaving(true);
    setSaveError(null);
    // Only send keys that actually changed — avoids reaping nulls for
    // fields the user didn't touch.
    const diff: Record<string, unknown> = {};
    for (const k of ["name", "domain", "primary_signer_name", "primary_signer_email",
                     "primary_signer_title", "address", "notes"] as const) {
      if (form[k] !== undefined && form[k] !== cp[k]) diff[k] = form[k];
    }
    if (Object.keys(diff).length === 0) {
      setEditing(false); setSaving(false);
      return;
    }
    const result = await opsPatch(`/api/counterparties/${id}`, diff);
    if (result.ok) {
      setEditing(false);
      setForm({});
      await load();
    } else {
      setSaveError(result.error || "Save failed");
    }
    setSaving(false);
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">Loading...</div>;
  if (notFound) return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-lg font-semibold text-zinc-200 mb-2">Counterparty not found</h1>
        <Link href="/contracts" className="text-xs text-amber-400 hover:text-amber-300">Back to contracts</Link>
      </div>
    </div>
  );
  if (!cp) return null;

  const field = (key: keyof Counterparty, value: string | null) =>
    editing ? (
      <input
        value={(form[key] as string | undefined) ?? value ?? ""}
        onChange={(e) => setForm(f => ({ ...f, [key]: e.target.value }))}
        className="w-full px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-100"
      />
    ) : (
      <span className="text-[12px] text-zinc-300">{value || <span className="text-zinc-600">—</span>}</span>
    );

  return (
    <div className="min-h-screen px-6 py-8">
      <div className="max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <Link href="/contracts" className="text-[10px] text-zinc-500 hover:text-zinc-300">
          ← Contracts
        </Link>

        {/* Header */}
        <div className="mt-2 mb-6 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Counterparty</div>
            {editing ? (
              <input
                value={(form.name as string | undefined) ?? cp.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                className="mt-1 w-full px-2 py-1 text-xl font-semibold bg-zinc-900 border border-zinc-700 rounded text-zinc-100"
              />
            ) : (
              <h1 className="text-xl font-semibold text-zinc-100">{cp.name}</h1>
            )}
            {cp.archived_at && (
              <span className="inline-block mt-1 px-2 py-0.5 text-[9px] rounded bg-zinc-800 text-zinc-500">archived</span>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {editing ? (
              <>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => { setEditing(false); setForm({}); setSaveError(null); }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                >
                  Cancel
                </button>
              </>
            ) : (
              !cp.archived_at && (
                <button
                  onClick={() => { setEditing(true); setForm({}); }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                >
                  Edit
                </button>
              )
            )}
          </div>
        </div>

        {saveError && (
          <div className="mb-4 px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-[11px] text-red-300">
            {saveError}
          </div>
        )}

        {/* Rollup */}
        {rollup && (
          <div className="grid grid-cols-5 gap-2 mb-6">
            {[
              { label: "Total", value: rollup.total, className: "text-zinc-200" },
              { label: "Drafting", value: rollup.drafting, className: "text-zinc-400" },
              { label: "Out for signature", value: rollup.out_for_signature, className: "text-violet-300" },
              { label: "Signed", value: rollup.signed, className: "text-emerald-300" },
              { label: "Declined", value: rollup.declined, className: "text-red-300" },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
                <div className="text-[9px] text-zinc-500 uppercase tracking-wider">{s.label}</div>
                <div className={`text-xl font-semibold ${s.className}`}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Identity fields */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 mb-6">
          <h2 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">Identity</h2>
          <dl className="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-zinc-500">Domain</dt>
            <dd>{field("domain", cp.domain)}</dd>
            <dt className="text-zinc-500">Primary signer</dt>
            <dd>{field("primary_signer_name", cp.primary_signer_name)}</dd>
            <dt className="text-zinc-500">Signer email</dt>
            <dd>{field("primary_signer_email", cp.primary_signer_email)}</dd>
            <dt className="text-zinc-500">Signer title</dt>
            <dd>{field("primary_signer_title", cp.primary_signer_title)}</dd>
            <dt className="text-zinc-500">Address</dt>
            <dd>{field("address", cp.address)}</dd>
          </dl>
          {(cp.notes || editing) && (
            <div className="mt-3 pt-3 border-t border-zinc-800">
              <div className="text-[9px] text-zinc-500 uppercase tracking-wider mb-1">Notes</div>
              {editing ? (
                <textarea
                  value={(form.notes as string | undefined) ?? cp.notes ?? ""}
                  onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  className="w-full px-2 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-100"
                />
              ) : (
                <p className="text-xs text-zinc-300 whitespace-pre-wrap">{cp.notes}</p>
              )}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-zinc-800 text-[9px] text-zinc-600">
            Created {new Date(cp.created_at).toLocaleDateString()} by {cp.created_by} · Updated {new Date(cp.updated_at).toLocaleDateString()}
          </div>
        </div>

        {/* Contracts */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50">
          <h2 className="px-4 pt-3 pb-2 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
            Contracts ({contracts.length})
          </h2>
          {contracts.length === 0 ? (
            <div className="px-4 pb-4 text-[11px] text-zinc-600">No contracts yet.</div>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {contracts.map((c) => {
                const status = displayStatus(c.draft_status, c.signing_status);
                return (
                  <li key={c.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${STATUS_PILL[status] || STATUS_PILL.draft}`}>
                        {status}
                      </span>
                      <Link
                        href={`/contracts?select=${c.id}`}
                        className="text-[12px] text-zinc-200 hover:text-amber-300 truncate flex-1"
                      >
                        {c.title}
                      </Link>
                      <span className="text-[9px] text-zinc-600 shrink-0">
                        {c.template_id || "—"} · {c.word_count} words
                      </span>
                      {c.total_signers > 0 && (
                        <span className={`text-[9px] shrink-0 ${c.signed_count === c.total_signers ? "text-emerald-400" : "text-zinc-500"}`}>
                          {c.signed_count}/{c.total_signers} signed
                        </span>
                      )}
                      <span className="text-[9px] text-zinc-600 shrink-0">
                        {new Date(c.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
