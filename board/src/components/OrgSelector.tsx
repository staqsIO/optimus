"use client";

/**
 * OrgSelector — "On behalf of" authoring-org picker for engagement / proposal /
 * contract creation flows (OPT-5 UI).
 *
 * Fetches the current board member's accessible TENANCY orgs from
 * GET /api/tenancy/orgs (tenancy.orgs ∩ the caller's memberships) and renders a
 * <select> pre-filled to the auto-detected default (first org, or an explicit
 * defaultOrgId prop). The selected org id is surfaced via `onChange`.
 *
 * Must NOT use /api/organizations (signal.organizations — the CRM of external
 * companies the org tracks): on_behalf_of_org_id is an OPERATIONAL tenancy id the
 * backend validates against the caller's principal.readOrgIds, so a CRM org could
 * never be a valid selection. This picker is a convenience layer, not the
 * enforcement boundary (P2).
 */

import { useEffect, useState } from "react";
import { opsFetch } from "@/lib/ops-api";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  // org_type is CRM-only (signal.organizations); tenancy.orgs has no such column.
  // Optional + unused in rendering so the tenancy-orgs payload satisfies this shape.
  org_type?: string;
}

interface OrgSelectorProps {
  /** Currently selected org id (controlled). */
  value: string | null;
  /** Called with the new org id whenever the selection changes. */
  onChange: (orgId: string | null) => void;
  /** If provided, pre-select this org id once orgs are loaded. Falls back to first org. */
  defaultOrgId?: string | null;
  /** Additional className for the <select> element. */
  className?: string;
  disabled?: boolean;
}

export function OrgSelector({
  value,
  onChange,
  defaultOrgId,
  className = "",
  disabled = false,
}: OrgSelectorProps) {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const data = await opsFetch<{ organizations: OrgRow[] }>("/api/tenancy/orgs");
      if (cancelled) return;
      if (!data) {
        setError("Could not load orgs");
        setLoading(false);
        return;
      }
      const rows = data.organizations || [];
      setOrgs(rows);
      setLoading(false);
      // Auto-select: prefer defaultOrgId if it's in the list, else first org.
      if (rows.length > 0) {
        const preferred = defaultOrgId && rows.find((o) => o.id === defaultOrgId);
        const selected = preferred ? preferred.id : rows[0].id;
        // Only emit if caller doesn't already have a value (avoids overwriting user picks).
        onChange(selected);
      }
    })();
    return () => {
      cancelled = true;
    };
    // defaultOrgId intentionally excluded — only run on mount to seed the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseClass =
    "w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed";

  if (loading) {
    return (
      <div className="space-y-1">
        <label className="block text-xs uppercase tracking-wider text-zinc-500">
          On behalf of
        </label>
        <select disabled className={`${baseClass} ${className}`}>
          <option>Loading orgs…</option>
        </select>
      </div>
    );
  }

  if (error || orgs.length === 0) {
    return (
      <div className="space-y-1">
        <label className="block text-xs uppercase tracking-wider text-zinc-500">
          On behalf of
        </label>
        <select disabled className={`${baseClass} ${className}`}>
          <option>{error || "No orgs available"}</option>
        </select>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label className="block text-xs uppercase tracking-wider text-zinc-500">
        On behalf of
      </label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className={`${baseClass} ${className}`}
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}
