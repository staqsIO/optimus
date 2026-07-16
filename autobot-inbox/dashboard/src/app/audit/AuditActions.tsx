"use client";

import { useState } from "react";

interface AuditResult {
  findings?: { severity: string; description: string; finding_type: string }[];
  error?: string;
}

const TIERS = [
  { tier: 1, label: "Tier 1", endpoint: "/api/audit/tier1", description: "Deterministic" },
  { tier: 2, label: "Tier 2", endpoint: "/api/audit/tier2", description: "AI Auditor" },
  { tier: 3, label: "Tier 3", endpoint: "/api/audit/tier3", description: "Cross-Model" },
] as const;

export default function AuditActions() {
  const [runningTier, setRunningTier] = useState<number | null>(null);
  const [result, setResult] = useState<{ tier: number; data: AuditResult } | null>(null);

  const runAudit = async (tier: number, endpoint: string) => {
    setRunningTier(tier);
    setResult(null);
    try {
      const res = await fetch(`/api/proxy?path=${encodeURIComponent(endpoint)}`);
      if (res.ok) {
        const data = await res.json();
        setResult({ tier, data });
      } else {
        setResult({ tier, data: { error: `Failed (${res.status})` } });
      }
    } catch {
      setResult({ tier, data: { error: "Request failed — API unavailable." } });
    }
    setRunningTier(null);
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Actions</h2>
      <div className="flex gap-3">
        {TIERS.map(({ tier, label, endpoint, description }) => (
          <button
            key={tier}
            onClick={() => runAudit(tier, endpoint)}
            disabled={runningTier !== null}
            className="px-4 py-2 text-sm rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
          >
            {runningTier === tier ? "Running..." : `Run ${label}`}
            <span className="block text-xs text-zinc-500 mt-0.5">{description}</span>
          </button>
        ))}
      </div>

      {result && (
        <div className="mt-4">
          {result.data.error ? (
            <div className="bg-surface-raised rounded-lg p-4 border border-red-500/20 text-red-400 text-sm">
              {result.data.error}
            </div>
          ) : result.data.findings && result.data.findings.length > 0 ? (
            <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
              <div className="px-6 py-3 border-b border-white/5">
                <span className="text-sm font-semibold">
                  Tier {result.tier} Results ({result.data.findings.length} findings)
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                    <th className="px-6 py-3">Severity</th>
                    <th className="px-6 py-3">Type</th>
                    <th className="px-6 py-3">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {result.data.findings.map((f, i) => (
                    <tr key={i}>
                      <td className="px-6 py-3">
                        <span className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400">
                          {f.severity}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-zinc-400">{f.finding_type}</td>
                      <td className="px-6 py-3 text-zinc-400">{f.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bg-surface-raised rounded-lg p-4 border border-green-500/20 text-green-400 text-sm">
              Tier {result.tier} audit passed with no findings.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
