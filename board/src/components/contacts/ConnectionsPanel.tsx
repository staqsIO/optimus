"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface Connection {
  contact_id: string;
  name: string | null;
  email: string | null;
  edge_type: "THREADED_WITH" | "PARTICIPATED_WITH" | "COLLABORATED_ON_PROJECT";
  edge_count: number;
  last_at: string | null;
}

interface ConnectionsResponse {
  connections: Connection[];
  graphAvailable: boolean;
}

const EDGE_LABEL: Record<Connection["edge_type"], string> = {
  THREADED_WITH: "threads",
  PARTICIPATED_WITH: "meetings",
  COLLABORATED_ON_PROJECT: "projects",
};

const EDGE_TINT: Record<Connection["edge_type"], string> = {
  THREADED_WITH: "text-blue-300 border-blue-400/30 bg-blue-500/10",
  PARTICIPATED_WITH: "text-violet-300 border-violet-400/30 bg-violet-500/10",
  COLLABORATED_ON_PROJECT: "text-emerald-300 border-emerald-400/30 bg-emerald-500/10",
};

export default function ConnectionsPanel({ contactId }: { contactId: string }) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resp = await opsFetch<ConnectionsResponse>(
        `/api/contacts/${contactId}/connections`,
      );
      if (!cancelled) {
        setData(resp);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (loading) {
    return (
      <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Connected to</h3>
        <p className="text-xs text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!data || !data.graphAvailable) {
    return (
      <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Connected to</h3>
        <p className="text-xs text-zinc-500">
          Graph database not available — relationships unavailable.
        </p>
      </div>
    );
  }

  if (data.connections.length === 0) {
    return (
      <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Connected to</h3>
        <p className="text-xs text-zinc-500">
          No inferred relationships yet. The hourly inferrer pass populates these from
          email threads, meeting transcripts, and shared projects.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-300">Connected to</h3>
        <span className="text-[10px] text-zinc-600">
          top {data.connections.length} · refreshed hourly
        </span>
      </div>
      <ul className="space-y-1.5">
        {data.connections.map((c) => (
          <li
            key={`${c.contact_id}-${c.edge_type}`}
            className="flex items-center justify-between gap-3"
          >
            <Link
              href={`/contacts/${c.contact_id}`}
              className="text-sm text-zinc-200 hover:text-zinc-50 truncate flex-1"
            >
              {c.name || c.email || "(unnamed)"}
            </Link>
            <span className="text-xs text-zinc-500 whitespace-nowrap">
              {c.edge_count}
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${
                EDGE_TINT[c.edge_type]
              }`}
            >
              {EDGE_LABEL[c.edge_type]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
