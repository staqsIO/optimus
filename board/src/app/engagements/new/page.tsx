"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OrgSelector } from "@/components/OrgSelector";

const KIND_OPTIONS = [
  { value: "website", label: "Website" },
  { value: "mobile_app", label: "Mobile app" },
  { value: "api", label: "API" },
  { value: "other", label: "Other" },
];

export default function NewEngagementPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [kind, setKind] = useState<string>("website");
  const [onBehalfOfOrgId, setOnBehalfOfOrgId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/engagements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          client: client.trim() || null,
          kind,
          ...(onBehalfOfOrgId ? { on_behalf_of_org_id: onBehalfOfOrgId } : {}),
        }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = await res.json();
      router.push(`/engagements/${data.engagement.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 max-w-xl mx-auto">
      <div className="mb-6">
        <Link href="/engagements" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Engagements
        </Link>
        <h1 className="text-xl font-semibold text-zinc-100 mt-2">New engagement</h1>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Marketing Site"
            className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
            Client (optional)
          </label>
          <input
            type="text"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="Acme Corp"
            className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
            Kind
          </label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-emerald-500"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <OrgSelector
          value={onBehalfOfOrgId}
          onChange={setOnBehalfOfOrgId}
          disabled={submitting}
        />

        {error && <div className="text-sm text-red-400">{error}</div>}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="px-3 py-1.5 text-sm bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
          >
            {submitting ? "Creating…" : "Create engagement"}
          </button>
          <Link
            href="/engagements"
            className="px-3 py-1.5 text-sm text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
