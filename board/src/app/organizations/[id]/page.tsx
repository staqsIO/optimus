"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  primary_domain: string | null;
  org_type: string;
  notes: string | null;
  contact_count: number;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberContact {
  id: string;
  name: string | null;
  email_address: string | null;
  contact_type: string;
  tier: string | null;
  is_vip: boolean;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  relationship_strength: number | null;
}

interface OrgAlias {
  alias: string;
  alias_type: string;
  created_at: string;
}

interface OrgSignal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  created_at: string;
  subject: string | null;
  channel: string;
  from_address: string | null;
}

interface OrgResponse {
  organization: OrgDetail;
  contacts: MemberContact[];
  aliases: OrgAlias[];
  recentSignals: OrgSignal[];
  error?: string;
}

function fmt(s: string | null): string {
  return s ? new Date(s).toLocaleString() : "—";
}

const TIER_TINT: Record<string, string> = {
  inner_circle: "text-emerald-300 border-emerald-400/30 bg-emerald-500/10",
  active: "text-blue-300 border-blue-400/30 bg-blue-500/10",
  inactive: "text-zinc-500 border-zinc-700/40 bg-zinc-700/30",
  inbound_only: "text-zinc-400 border-white/10 bg-white/[0.02]",
};

export default function OrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<OrgResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const resp = await opsFetch<OrgResponse>(`/api/organizations/${id}`);
      if (!cancelled) {
        setData(resp);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) return <div className="px-6 py-8 text-sm text-zinc-500">Loading…</div>;
  if (!data || data.error || !data.organization) {
    return (
      <div className="px-6 py-8">
        <p className="text-sm text-rose-400">Organization not found.</p>
        <Link href="/organizations" className="text-xs text-zinc-400 hover:text-zinc-200">
          ← back to organizations
        </Link>
      </div>
    );
  }

  const o = data.organization;

  return (
    <div className="px-6 py-8 max-w-5xl">
      <Link
        href="/organizations"
        className="text-xs text-zinc-500 hover:text-zinc-300 mb-3 inline-block"
      >
        ← organizations
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-light text-zinc-100">{o.name}</h1>
        <div className="text-xs text-zinc-500 mt-1">
          <span className="font-mono">{o.org_type}</span>
          {o.primary_domain && <span> · {o.primary_domain}</span>}
          <span> · {o.contact_count} contact{o.contact_count === 1 ? "" : "s"}</span>
          {o.last_activity_at && <span> · last activity {fmt(o.last_activity_at)}</span>}
        </div>
      </div>

      {data.aliases.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Known as
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.aliases.map((a) => (
              <span
                key={a.alias}
                className="text-xs px-2 py-1 rounded border border-white/10 bg-white/[0.02] text-zinc-300"
              >
                {a.alias}{" "}
                <span className="text-[10px] text-zinc-600">{a.alias_type}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mb-8">
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
          Members · {data.contacts.length}
        </h2>
        {data.contacts.length === 0 ? (
          <p className="text-sm text-zinc-600 italic">No contacts linked yet.</p>
        ) : (
          <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden">
            {data.contacts.map((c) => (
              <li
                key={c.id}
                className="bg-white/[0.02] hover:bg-white/[0.04]"
              >
                <Link
                  href={`/contacts/${c.id}`}
                  className="block px-4 py-3 flex items-center justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-100 truncate">
                        {c.name || c.email_address}
                      </span>
                      {c.is_vip && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-500/10 text-amber-300">
                          VIP
                        </span>
                      )}
                      {c.tier && c.tier !== "unknown" && (
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            TIER_TINT[c.tier] || "text-zinc-500 border-white/10"
                          }`}
                        >
                          {c.tier.replace("_", " ")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 truncate">
                      {c.email_address}
                      {" · "}
                      {c.emails_received} in / {c.emails_sent} out
                    </div>
                  </div>
                  <div className="text-[10px] text-zinc-600 ml-3 whitespace-nowrap">
                    {c.last_received_at ? fmt(c.last_received_at).split(",")[0] : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
          Recent signals · {data.recentSignals.length}
        </h2>
        {data.recentSignals.length === 0 ? (
          <p className="text-sm text-zinc-600 italic">No signals yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.recentSignals.map((s) => (
              <li
                key={s.id}
                className="px-3 py-2 rounded border border-white/5 bg-white/[0.02]"
              >
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 mb-1">
                  <span className="font-mono">{s.signal_type}</span>
                  <span className="text-zinc-600">·</span>
                  <span>{Math.round(s.confidence * 100)}%</span>
                  <span className="text-zinc-600">·</span>
                  <span>{fmt(s.created_at)}</span>
                  {s.from_address && (
                    <>
                      <span className="text-zinc-600">·</span>
                      <span className="truncate">{s.from_address}</span>
                    </>
                  )}
                </div>
                <div className="text-xs text-zinc-300 leading-snug">
                  {s.content}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
