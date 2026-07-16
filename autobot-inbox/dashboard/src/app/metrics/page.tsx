import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

interface MetricsResponse {
  metrics: {
    m1_inbox_zero_rate_pct: number | null;
    m2_avg_triage_latency_min: number | null;
    m3_draft_accuracy_pct: number | null;
    m4_edit_rate_14d_pct: number | null;
    m5_drafts_reviewed_14d: number | null;
    m6_avg_daily_cost_usd: number | null;
    m7_budget_utilization_pct: number | null;
    m8_hash_chain_valid: boolean | null;
    m9_gate_enforcement_pct: number | null;
    m10_total_halts: number | null;
    m11_signals_per_email: number | null;
    m12_voice_samples: number | null;
    m13_l0_exit_ready: boolean | null;
  } | null;
}

interface MetricCard {
  id: string;
  label: string;
  value: string;
  target: string;
  met: boolean;
  category: string;
}

function n(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const num = Number(v);
  return Number.isNaN(num) ? fallback : num;
}

function formatMetric(
  metrics: MetricsResponse["metrics"],
): MetricCard[] {
  if (!metrics) return [];
  return [
    {
      id: "m1",
      label: "Inbox Zero Rate",
      value: `${n(metrics.m1_inbox_zero_rate_pct)}%`,
      target: ">90%",
      met: n(metrics.m1_inbox_zero_rate_pct) >= 90,
      category: "Throughput",
    },
    {
      id: "m2",
      label: "Avg Triage Latency",
      value: `${n(metrics.m2_avg_triage_latency_min)} min`,
      target: "<5 min",
      met: n(metrics.m2_avg_triage_latency_min, 999) < 5,
      category: "Throughput",
    },
    {
      id: "m3",
      label: "Draft Accuracy",
      value: `${n(metrics.m3_draft_accuracy_pct)}%`,
      target: ">80%",
      met: n(metrics.m3_draft_accuracy_pct) >= 80,
      category: "Quality",
    },
    {
      id: "m4",
      label: "Edit Rate (14d)",
      value: `${n(metrics.m4_edit_rate_14d_pct)}%`,
      target: "<10%",
      met: n(metrics.m4_edit_rate_14d_pct, 100) < 10,
      category: "Quality",
    },
    {
      id: "m5",
      label: "Drafts Reviewed (14d)",
      value: `${n(metrics.m5_drafts_reviewed_14d)}`,
      target: ">=50",
      met: n(metrics.m5_drafts_reviewed_14d) >= 50,
      category: "Autonomy",
    },
    {
      id: "m6",
      label: "Avg Daily Cost",
      value: `$${n(metrics.m6_avg_daily_cost_usd).toFixed(2)}`,
      target: "<$5",
      met: n(metrics.m6_avg_daily_cost_usd, 999) < 5,
      category: "Cost",
    },
    {
      id: "m7",
      label: "Budget Utilization",
      value: `${n(metrics.m7_budget_utilization_pct)}%`,
      target: "<80%",
      met: n(metrics.m7_budget_utilization_pct, 100) < 80,
      category: "Cost",
    },
    {
      id: "m8",
      label: "Hash Chain Integrity",
      value: metrics.m8_hash_chain_valid ? "Valid" : "BROKEN",
      target: "Valid",
      met: metrics.m8_hash_chain_valid === true,
      category: "Integrity",
    },
    {
      id: "m9",
      label: "Gate Enforcement",
      value: `${n(metrics.m9_gate_enforcement_pct)}%`,
      target: "100%",
      met: n(metrics.m9_gate_enforcement_pct) >= 100,
      category: "Integrity",
    },
    {
      id: "m10",
      label: "Total Halts",
      value: `${n(metrics.m10_total_halts)}`,
      target: "Tracked",
      met: true,
      category: "Safety",
    },
    {
      id: "m11",
      label: "Signals per Email",
      value: `${n(metrics.m11_signals_per_email)}`,
      target: ">1.0",
      met: n(metrics.m11_signals_per_email) >= 1.0,
      category: "Signal",
    },
    {
      id: "m12",
      label: "Voice Samples",
      value: `${n(metrics.m12_voice_samples)}`,
      target: ">100",
      met: n(metrics.m12_voice_samples) >= 100,
      category: "Voice",
    },
    {
      id: "m13",
      label: "L0 Exit Ready",
      value: metrics.m13_l0_exit_ready ? "YES" : "No",
      target: "Yes",
      met: metrics.m13_l0_exit_ready === true,
      category: "Autonomy",
    },
  ];
}

export default async function MetricsPage() {
  let metrics: MetricsResponse["metrics"] = null;
  try {
    const data = await apiFetch<MetricsResponse>("/api/metrics");
    metrics = data?.metrics ?? null;
  } catch { /* API timeout or unavailable */ }
  const cards = formatMetric(metrics);
  const metCount = cards.filter((c) => c.met).length;
  const totalCount = cards.length;

  const categories = [...new Set(cards.map((c) => c.category))];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Phase 1 Metrics</h1>
        <div className="text-sm text-zinc-400">
          <span
            className={
              metCount >= totalCount ? "text-green-400" : "text-yellow-400"
            }
          >
            {metCount}/{totalCount}
          </span>{" "}
          targets met
        </div>
      </div>

      {categories.map((cat) => (
        <section key={cat}>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            {cat}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards
              .filter((c) => c.category === cat)
              .map((card) => (
                <div
                  key={card.id}
                  className={`bg-surface-raised rounded-lg p-4 border ${card.met ? "border-green-500/20" : "border-yellow-500/20"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-500">{card.id.toUpperCase()}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${card.met ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}
                    >
                      {card.met ? "MET" : "NOT MET"}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-400 mb-1">
                    {card.label}
                  </div>
                  <div className="text-2xl font-bold">{card.value}</div>
                  <div className="text-xs text-zinc-500 mt-1">
                    Target: {card.target}
                  </div>
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
