"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface Account {
  id: string;
  label: string;
  identifier: string;
  is_active: boolean;
}

/**
 * Account selector dropdown for the board dashboard.
 * Default view is org-wide (all businesses). Account filter is a lens
 * for focused inspection, not an access wall.
 * Selection stored in URL search params (?account=all or ?account=<id>).
 */
export default function AccountSelector() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const currentAccount = searchParams.get("account") || "all";

  useEffect(() => {
    async function fetchAccounts() {
      try {
        const res = await fetch(
          `/api/ops?path=${encodeURIComponent("/api/accounts")}`
        );
        if (res.ok) {
          const data = await res.json();
          setAccounts(data.accounts || []);
        }
      } catch {
        // Accounts endpoint may not exist yet — show org-wide only
      } finally {
        setLoading(false);
      }
    }
    fetchAccounts();
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") {
      params.delete("account");
    } else {
      params.set("account", value);
    }
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  }

  if (loading || accounts.length <= 1) {
    // Don't show selector for single-account setups
    return null;
  }

  return (
    <select
      value={currentAccount}
      onChange={handleChange}
      className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
      title="Filter by business account"
    >
      <option value="all">All (Org-wide)</option>
      {accounts
        .filter((a) => a.is_active)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.label || a.identifier}
          </option>
        ))}
    </select>
  );
}
