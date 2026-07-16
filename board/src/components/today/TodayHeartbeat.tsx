"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface Service {
  name: string;
  last_run_at: string | null;
  last_status: "ok" | "failed" | "running" | "skipped" | null;
  failure_count: number;
}

interface ServicesResponse {
  services: Service[];
}

interface Heartbeat {
  total: number;
  failed: number;
  lastActivityName: string | null;
  lastActivityAt: string | null;
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function summarize(services: Service[]): Heartbeat {
  let lastAt: number | null = null;
  let lastName: string | null = null;
  let failed = 0;

  for (const svc of services) {
    if (svc.last_status === "failed" || svc.failure_count > 0) failed += 1;
    if (svc.last_run_at) {
      const t = new Date(svc.last_run_at).getTime();
      if (lastAt === null || t > lastAt) {
        lastAt = t;
        lastName = svc.name;
      }
    }
  }

  return {
    total: services.length,
    failed,
    lastActivityName: lastName,
    lastActivityAt: lastAt ? new Date(lastAt).toISOString() : null,
  };
}

export default function TodayHeartbeat() {
  const [hb, setHb] = useState<Heartbeat | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const data = await opsFetch<ServicesResponse>("/api/services/status");
      if (cancelled) return;
      setHb(summarize(data?.services ?? []));
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!hb) {
    return <span className="text-xs text-zinc-600 whitespace-nowrap">Agents polling</span>;
  }

  if (hb.total === 0) {
    return <span className="text-xs text-zinc-600 whitespace-nowrap">No services running</span>;
  }

  const dotColor = hb.failed > 0 ? "bg-amber-400" : "bg-emerald-500";
  const lastLabel =
    hb.lastActivityName && hb.lastActivityAt
      ? `${hb.lastActivityName} ${relative(hb.lastActivityAt)}`
      : "no recent activity";

  return (
    <Link
      href="/agents?tab=services"
      className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 whitespace-nowrap transition-colors"
      title={`${hb.total} services · ${hb.failed} failing`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span>
        {hb.total} services
        {hb.failed > 0 ? ` · ${hb.failed} failing` : ""} · {lastLabel}
      </span>
    </Link>
  );
}
