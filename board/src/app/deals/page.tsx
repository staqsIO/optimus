"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { opsFetch, opsPost, opsPatch, opsDelete } from "@/lib/ops-api";

type Stage =
  | "prospect"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost"
  | "churned";

const STAGE_ORDER: Stage[] = [
  "prospect",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
];

const STAGE_LABEL: Record<Stage, string> = {
  prospect: "Prospect",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
  churned: "Churned",
};

const STAGE_TINT: Record<Stage, string> = {
  prospect: "border-zinc-500/30 bg-white/[0.02]",
  qualified: "border-blue-400/30 bg-blue-500/[0.05]",
  proposal: "border-violet-400/30 bg-violet-500/[0.05]",
  negotiation: "border-amber-400/30 bg-amber-500/[0.05]",
  won: "border-emerald-400/30 bg-emerald-500/[0.05]",
  lost: "border-rose-400/30 bg-rose-500/[0.05]",
  churned: "border-rose-400/20 bg-rose-500/[0.03]",
};

interface Deal {
  id: string;
  contact_id: string;
  contact_name: string | null;
  contact_email: string | null;
  organization_id: string | null;
  organization_name: string | null;
  title: string;
  stage: Stage;
  value_usd: string | null;
  expected_close: string | null;
  notes: string | null;
  last_activity_at: string;
  created_at: string;
  closed_at: string | null;
}

interface Contact {
  id: string;
  name: string | null;
  email_address: string | null;
}

function fmtUsd(v: string | null): string {
  if (v == null) return "";
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  return new Date(s).toLocaleDateString();
}

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newContact, setNewContact] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [d, c] = await Promise.all([
      opsFetch<{ deals: Deal[] }>("/api/deals"),
      opsFetch<{ contacts: Contact[] }>("/api/contacts"),
    ]);
    setDeals(d?.deals || []);
    setContacts(c?.contacts || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const advance = useCallback(
    async (deal: Deal, direction: 1 | -1) => {
      const idx = STAGE_ORDER.indexOf(deal.stage);
      if (idx < 0) return;
      const nextIdx = Math.min(STAGE_ORDER.length - 1, Math.max(0, idx + direction));
      const next = STAGE_ORDER[nextIdx];
      if (next === deal.stage) return;
      setBusy(deal.id);
      const result = await opsPatch<{ deal: Deal }>(`/api/deals/${deal.id}`, {
        stage: next,
      });
      if (result.ok) await refresh();
      setBusy(null);
    },
    [refresh],
  );

  const setStage = useCallback(
    async (deal: Deal, stage: Stage) => {
      if (stage === deal.stage) return;
      setBusy(deal.id);
      const result = await opsPatch<{ deal: Deal }>(`/api/deals/${deal.id}`, { stage });
      if (result.ok) await refresh();
      setBusy(null);
    },
    [refresh],
  );

  const remove = useCallback(
    async (deal: Deal) => {
      if (!confirm(`Delete deal "${deal.title}"?`)) return;
      const result = await opsDelete<{ ok: true }>(`/api/deals/${deal.id}`);
      if (result.ok) await refresh();
    },
    [refresh],
  );

  const create = useCallback(async () => {
    if (!newContact || !newTitle.trim()) return;
    const value = Number(newValue);
    const result = await opsPost<{ deal: Deal }>("/api/deals", {
      contact_id: newContact,
      title: newTitle.trim(),
      value_usd: Number.isFinite(value) && value > 0 ? value : null,
    });
    if (result.ok) {
      setNewContact("");
      setNewTitle("");
      setNewValue("");
      setShowNew(false);
      await refresh();
    }
  }, [newContact, newTitle, newValue, refresh]);

  const byStage: Record<Stage, Deal[]> = {
    prospect: [],
    qualified: [],
    proposal: [],
    negotiation: [],
    won: [],
    lost: [],
    churned: [],
  };
  for (const d of deals) byStage[d.stage]?.push(d);

  const totalOpen = deals.filter(
    (d) => !["won", "lost", "churned"].includes(d.stage),
  ).length;
  const totalValue = deals
    .filter((d) => !["lost", "churned"].includes(d.stage))
    .reduce((sum, d) => sum + (Number(d.value_usd) || 0), 0);

  return (
    <div className="px-6 py-8">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-xl font-light text-zinc-100 mb-1">Deals</h1>
          <p className="text-xs text-zinc-500">
            {totalOpen} open · {fmtUsd(String(totalValue))} on the table
          </p>
        </div>
        <button
          onClick={() => setShowNew((v) => !v)}
          className="text-xs px-3 py-1.5 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
        >
          {showNew ? "Cancel" : "+ New deal"}
        </button>
      </div>

      {showNew && (
        <div className="mb-6 p-4 rounded border border-white/10 bg-white/[0.02]">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <select
              value={newContact}
              onChange={(e) => setNewContact(e.target.value)}
              className="px-3 py-2 text-sm bg-zinc-900 border border-white/10 rounded text-zinc-200"
            >
              <option value="">— pick contact —</option>
              {contacts
                .filter((c) => c.name)
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.email_address && `· ${c.email_address}`}
                  </option>
                ))}
            </select>
            <input
              type="text"
              placeholder="Deal title…"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="px-3 py-2 text-sm bg-zinc-900 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600"
            />
            <input
              type="number"
              placeholder="Value USD (optional)"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className="px-3 py-2 text-sm bg-zinc-900 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600"
            />
          </div>
          <button
            onClick={create}
            disabled={!newContact || !newTitle.trim()}
            className="text-xs px-3 py-1.5 rounded bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-40"
          >
            Create deal
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : deals.length === 0 ? (
        <div className="text-sm text-zinc-500 italic">
          No deals yet. Click <span className="font-mono">+ New deal</span> to start one.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {STAGE_ORDER.map((stage) => {
            const stageDeals = byStage[stage];
            const stageValue = stageDeals.reduce(
              (s, d) => s + (Number(d.value_usd) || 0),
              0,
            );
            return (
              <div
                key={stage}
                className={`rounded-lg border ${STAGE_TINT[stage]} p-3 min-h-[200px]`}
              >
                <div className="mb-3">
                  <div className="text-xs uppercase tracking-wider text-zinc-400">
                    {STAGE_LABEL[stage]}
                  </div>
                  <div className="text-[10px] text-zinc-600">
                    {stageDeals.length} · {fmtUsd(String(stageValue))}
                  </div>
                </div>
                <ul className="space-y-2">
                  {stageDeals.map((d) => (
                    <li
                      key={d.id}
                      className={`p-2.5 rounded border border-white/10 bg-zinc-900 ${
                        busy === d.id ? "opacity-50" : ""
                      }`}
                    >
                      <div className="text-sm text-zinc-100 leading-tight mb-0.5">
                        {d.title}
                      </div>
                      <Link
                        href={`/contacts/${d.contact_id}`}
                        className="text-xs text-zinc-400 hover:text-zinc-200 truncate block"
                      >
                        {d.contact_name || d.contact_email}
                      </Link>
                      {d.organization_name && (
                        <Link
                          href={`/organizations/${d.organization_id}`}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300 truncate block"
                        >
                          {d.organization_name}
                        </Link>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        {d.value_usd && (
                          <span className="text-[10px] text-emerald-400 font-mono">
                            {fmtUsd(d.value_usd)}
                          </span>
                        )}
                        {d.expected_close && (
                          <span className="text-[10px] text-zinc-500">
                            close {fmtDate(d.expected_close)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-2 -mx-1">
                        <button
                          onClick={() => advance(d, -1)}
                          disabled={STAGE_ORDER.indexOf(d.stage) === 0}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 disabled:opacity-30"
                        >
                          ←
                        </button>
                        <select
                          value={d.stage}
                          onChange={(e) => setStage(d, e.target.value as Stage)}
                          className="flex-1 text-[10px] bg-zinc-900 border border-white/10 rounded px-1 py-0.5 text-zinc-300"
                        >
                          {(Object.keys(STAGE_LABEL) as Stage[]).map((s) => (
                            <option key={s} value={s}>
                              {STAGE_LABEL[s]}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => advance(d, 1)}
                          disabled={
                            STAGE_ORDER.indexOf(d.stage) === STAGE_ORDER.length - 1
                          }
                          className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 disabled:opacity-30"
                        >
                          →
                        </button>
                        <button
                          onClick={() => remove(d)}
                          className="text-[10px] px-1.5 py-0.5 rounded text-zinc-500 hover:text-rose-400"
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
