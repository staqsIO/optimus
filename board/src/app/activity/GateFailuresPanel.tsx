"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface GateResult {
  passed: boolean;
  score?: number | null;
  threshold?: number | null;
  note?: string | null;
  method?: string | null;
  matches?: string[];
  reason?: string;
  skipped?: boolean;
}

interface FailedProposal {
  id: string;
  created_at: string;
  action_type: string;
  subject: string | null;
  body: string;
  to_addresses: string[] | null;
  channel: string | null;
  work_item_id: string | null;
  tone_score: number | null;
  gate_results: Record<string, GateResult>;
  reviewer_verdict: string | null;
  reviewer_notes: string | null;
  work_item_title: string | null;
}

interface Response {
  proposals: FailedProposal[];
}

const GATE_LABELS: Record<string, string> = {
  G1: "Budget",
  G2: "Commitment",
  G3: "Tone",
  G4: "Autonomy",
  G5: "Reversibility",
  G6: "Stakeholder",
  G7: "Precedent",
  G8: "Injection",
  G9: "Classification",
  G10: "Spend cap",
  G11: "Retrospective",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function failedGates(results: Record<string, GateResult>): Array<{ key: string; result: GateResult }> {
  return Object.entries(results)
    .filter(([, r]) => r && typeof r === "object" && r.passed === false)
    .map(([key, result]) => ({ key, result }));
}

function describeGate(key: string, r: GateResult): string {
  const parts: string[] = [];
  if (r.score != null) {
    parts.push(`score ${r.score}${r.threshold != null ? ` < ${r.threshold}` : ""}`);
  }
  if (r.matches && r.matches.length > 0) {
    parts.push(`${r.matches.length} match${r.matches.length === 1 ? "" : "es"}`);
  }
  if (r.note) parts.push(r.note);
  if (r.reason) parts.push(r.reason);
  return parts.join(" · ") || "failed";
}

export default function GateFailuresPanel() {
  const [data, setData] = useState<FailedProposal[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const result = await opsFetch<Response>("/api/activity/gate-failures?limit=50");
    setData(result?.proposals ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return <div className="text-zinc-500 text-sm py-8 text-center">Loading gate failures…</div>;
  }

  if (data.length === 0) {
    return (
      <div className="text-zinc-500 text-sm py-8 text-center">
        No gate failures in the recent feed. All drafts are passing G1–G11.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.map((p) => {
        const failed = failedGates(p.gate_results);
        const recipient = p.to_addresses?.[0] || "unknown";
        const preview = p.body.slice(0, 200);
        return (
          <div
            key={p.id}
            className="bg-zinc-900 border border-white/5 rounded-lg p-4 hover:border-white/10 transition-colors"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  {failed.map(({ key }) => (
                    <span
                      key={key}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-300 border border-red-500/30"
                    >
                      {key} {GATE_LABELS[key] ? `· ${GATE_LABELS[key]}` : ""}
                    </span>
                  ))}
                  {p.reviewer_verdict && (
                    <span className="text-[10px] text-zinc-500">{p.reviewer_verdict}</span>
                  )}
                </div>
                <div className="text-sm text-zinc-300 truncate">
                  {p.subject || "(no subject)"} <span className="text-zinc-600">→ {recipient}</span>
                </div>
              </div>
              <span className="text-[10px] text-zinc-600 shrink-0">{relativeTime(p.created_at)}</span>
            </div>

            <div className="space-y-1 mt-2 pl-2 border-l-2 border-red-600/40">
              {failed.map(({ key, result }) => (
                <div key={key} className="text-xs">
                  <span className="text-red-400 font-mono">{key}</span>{" "}
                  <span className="text-zinc-400">{describeGate(key, result)}</span>
                </div>
              ))}
            </div>

            {preview && (
              <p className="text-[11px] text-zinc-500 italic mt-2 line-clamp-2">
                {preview}
                {p.body.length > 200 && "…"}
              </p>
            )}

            {p.work_item_id && (
              <div className="mt-2 pt-2 border-t border-white/5">
                <Link
                  href={`/activity?work_item_id=${p.work_item_id}`}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Open work item →
                </Link>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
