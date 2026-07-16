"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  primary_domain: string | null;
  org_type: string;
  contact_count: number;
  inner_circle_count: number;
  last_activity_at: string | null;
  created_at: string;
}

const TYPE_TINT: Record<string, string> = {
  startup: "text-emerald-300 border-emerald-400/30 bg-emerald-500/10",
  agency: "text-violet-300 border-violet-400/30 bg-violet-500/10",
  vendor: "text-amber-300 border-amber-400/30 bg-amber-500/10",
  customer: "text-cyan-300 border-cyan-400/30 bg-cyan-500/10",
  partner: "text-blue-300 border-blue-400/30 bg-blue-500/10",
  service: "text-zinc-400 border-white/10 bg-white/5",
  investor: "text-rose-300 border-rose-400/30 bg-rose-500/10",
  unknown: "text-zinc-500 border-white/5 bg-white/[0.02]",
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

export default function OrganizationsPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = await opsFetch<{ organizations: OrgRow[] }>("/api/organizations");
      if (!cancelled) {
        setOrgs(data?.organizations || []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = search
    ? orgs.filter(
        (o) =>
          o.name.toLowerCase().includes(search.toLowerCase()) ||
          (o.primary_domain || "").toLowerCase().includes(search.toLowerCase()),
      )
    : orgs;

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-light text-zinc-100 mb-1">Organizations</h1>
        <p className="text-xs text-zinc-500">
          Companies and entities people are associated with. Backfilled from{" "}
          <span className="font-mono">contacts.organization</span> text; promoted to
          first-class via migration 080.
        </p>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search organizations…"
        className="w-full max-w-md px-3 py-2 mb-6 text-sm bg-zinc-900 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/50"
      />

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-zinc-500 italic">
          {search ? "No matches." : "No organizations yet."}
        </div>
      ) : (
        <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden">
          {filtered.map((o) => (
            <li key={o.id} className="bg-white/[0.02] hover:bg-white/[0.04]">
              <Link
                href={`/organizations/${o.id}`}
                className="block px-4 py-3 flex items-center justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-100 truncate">{o.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        TYPE_TINT[o.org_type] || TYPE_TINT.unknown
                      }`}
                    >
                      {o.org_type}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {o.primary_domain || "no domain"} · {o.contact_count} contact
                    {o.contact_count === 1 ? "" : "s"}
                    {o.inner_circle_count > 0 && (
                      <span className="text-emerald-400">
                        {" "}· {o.inner_circle_count} inner circle
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[10px] text-zinc-600 ml-3 whitespace-nowrap">
                  active {fmtDate(o.last_activity_at)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
