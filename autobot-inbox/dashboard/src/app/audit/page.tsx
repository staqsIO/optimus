import { apiFetch } from "@/lib/api";
import AuditActions from "./AuditActions";

export const dynamic = "force-dynamic";

interface AuditSummary {
  totalFindings: number;
  bySeverity: Record<string, number>;
  byTier: Record<string, number>;
  recentRuns: Record<string, unknown>[];
}

interface Finding {
  audit_tier: string;
  finding_type: string;
  severity: string;
  description: string;
  created_at: string;
}

interface ConstitutionalEvaluation {
  work_item_id: string;
  evaluation_mode: string;
  overall_verdict: string;
  would_have_blocked: boolean;
  created_at: string;
}

interface Intervention {
  intervention_type: string;
  action: string;
  board_member: string;
  created_at: string;
}

interface AuditRun {
  id: string;
  audit_tier: number;
  model_used: string;
  status: string;
  findings_count: number;
  started_at: string;
  completed_at: string | null;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/20",
  high: "bg-orange-500/20 text-orange-400 border-orange-500/20",
  medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/20",
  low: "bg-blue-500/20 text-blue-400 border-blue-500/20",
};

export default async function AuditPage() {
  const safe = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch { return null; }
  };

  const [summary, findingsRes, modeRes, evalsRes, interventionsRes, runsRes] = await Promise.all([
    safe(() => apiFetch<AuditSummary>("/api/audit/summary")),
    safe(() => apiFetch<{ findings: Finding[] }>("/api/audit/findings")),
    safe(() => apiFetch<{ mode: string }>("/api/constitutional/mode")),
    safe(() => apiFetch<{ evaluations: ConstitutionalEvaluation[] }>("/api/constitutional/evaluations")),
    safe(() => apiFetch<{ interventions: Intervention[] }>("/api/constitutional/interventions")),
    safe(() => apiFetch<{ runs: AuditRun[] }>("/api/audit/runs")),
  ]);
  const findings = findingsRes?.findings ?? null;
  const constitutionalMode = modeRes?.mode ?? null;
  const evaluations = evalsRes?.evaluations ?? null;
  const interventions = interventionsRes?.interventions ?? null;
  const auditRuns = runsRes?.runs ?? null;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold">Audit</h1>
        {constitutionalMode != null && (
          <span
            className={`px-3 py-1 rounded text-xs font-semibold uppercase tracking-wider ${
              constitutionalMode === "active"
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
            }`}
          >
            Constitutional: {constitutionalMode}
          </span>
        )}
      </div>

      {/* Findings Summary */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Findings Summary</h2>
        {summary ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {(["critical", "high", "medium", "low"] as const).map((sev) => (
              <div
                key={sev}
                className={`bg-surface-raised rounded-lg p-4 border ${
                  SEVERITY_COLORS[sev]?.split(" ").pop() ?? "border-white/5"
                }`}
              >
                <div className="text-xs text-zinc-500 mb-1 capitalize">{sev}</div>
                <div className="text-2xl font-bold">
                  {summary.bySeverity?.[sev] ?? 0}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Audit summary data unavailable.
          </div>
        )}
        {summary && (
          <div className="mt-3 text-sm text-zinc-400">
            Total findings: {summary.totalFindings}
          </div>
        )}
      </section>

      {/* Recent Audit Runs */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Recent Audit Runs</h2>
        {auditRuns && auditRuns.length > 0 ? (
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                  <th className="px-6 py-3">Tier</th>
                  <th className="px-6 py-3">Model</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Findings</th>
                  <th className="px-6 py-3">Started</th>
                  <th className="px-6 py-3">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {auditRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="px-6 py-3 text-zinc-400">{r.audit_tier}</td>
                    <td className="px-6 py-3 text-zinc-400 text-xs">{r.model_used}</td>
                    <td className="px-6 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          r.status === "completed"
                            ? "bg-green-500/20 text-green-400"
                            : r.status === "failed"
                              ? "bg-red-500/20 text-red-400"
                              : "bg-yellow-500/20 text-yellow-400"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-zinc-400">{r.findings_count ?? "—"}</td>
                    <td className="px-6 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {r.completed_at ? new Date(r.completed_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            {auditRuns === null ? "Audit runs data unavailable." : "No audit runs recorded."}
          </div>
        )}
      </section>

      {/* Recent Findings Table */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Recent Findings</h2>
        {findings && findings.length > 0 ? (
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                  <th className="px-6 py-3">Tier</th>
                  <th className="px-6 py-3">Severity</th>
                  <th className="px-6 py-3">Type</th>
                  <th className="px-6 py-3">Description</th>
                  <th className="px-6 py-3">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {findings.map((f, i) => (
                  <tr key={i}>
                    <td className="px-6 py-3 text-zinc-400">{f.audit_tier}</td>
                    <td className="px-6 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          SEVERITY_COLORS[f.severity] ?? "bg-zinc-500/20 text-zinc-400"
                        }`}
                      >
                        {f.severity}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-zinc-400">{f.finding_type}</td>
                    <td className="px-6 py-3 max-w-xs truncate text-zinc-400">
                      {f.description}
                    </td>
                    <td className="px-6 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(f.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            {findings === null ? "Findings data unavailable." : "No findings recorded."}
          </div>
        )}
      </section>

      {/* Constitutional Evaluations */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Constitutional Evaluations</h2>
        {evaluations && evaluations.length > 0 ? (
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                  <th className="px-6 py-3">Work Item</th>
                  <th className="px-6 py-3">Verdict</th>
                  <th className="px-6 py-3">Would Block</th>
                  <th className="px-6 py-3">Mode</th>
                  <th className="px-6 py-3">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {evaluations.map((e, i) => (
                  <tr key={i}>
                    <td className="px-6 py-3 text-zinc-400 font-mono text-xs">
                      {e.work_item_id.slice(0, 8)}
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          e.overall_verdict === "pass"
                            ? "bg-green-500/20 text-green-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {e.overall_verdict}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      {e.would_have_blocked ? (
                        <span className="text-status-action text-xs">Yes</span>
                      ) : (
                        <span className="text-zinc-500 text-xs">No</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-zinc-400 text-xs">
                      {e.evaluation_mode}
                    </td>
                    <td className="px-6 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            {evaluations === null
              ? "Constitutional evaluation data unavailable."
              : "No evaluations recorded."}
          </div>
        )}
      </section>

      {/* Board Interventions */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Board Interventions</h2>
        {interventions && interventions.length > 0 ? (
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-white/5">
                  <th className="px-6 py-3">Type</th>
                  <th className="px-6 py-3">Action</th>
                  <th className="px-6 py-3">Board Member</th>
                  <th className="px-6 py-3">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {interventions.map((iv, i) => (
                  <tr key={i}>
                    <td className="px-6 py-3 text-zinc-400">
                      {iv.intervention_type}
                    </td>
                    <td className="px-6 py-3 max-w-xs truncate">
                      {iv.action}
                    </td>
                    <td className="px-6 py-3 text-zinc-400">{iv.board_member}</td>
                    <td className="px-6 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(iv.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            {interventions === null
              ? "Intervention data unavailable."
              : "No interventions recorded."}
          </div>
        )}
      </section>

      {/* Audit Action */}
      <AuditActions />
    </div>
  );
}
