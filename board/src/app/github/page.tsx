"use client";

// STAQPRO-532 — first-class read-only view of agent-authored GitHub PR/issue activity.
// Reads GET /api/github/activity (inbox-proxy, viewer-scoped via mayReadOrgShared on the
// backend). No actions here — every interactive affordance links out to GitHub.

import { Suspense, useCallback, useEffect, useState } from "react";
import { inboxGet, timeAgo } from "@/components/inbox/shared";
import { usePageContext } from "@/contexts/PageContext";

interface PullRequest {
  id: string;
  title: string;
  status: "open" | "merged" | "closed";
  github_pr_url: string | null;
  github_pr_number: number | null;
  target_repo: string | null;
  linear_issue_url: string | null;
  campaign_id: string | null;
  reviewer_verdict: string | null;
  created_at: string;
  updated_at: string;
}

interface IssueEvent {
  id: string;
  title: string | null;
  source_issue_url: string | null;
  source_issue_id: string | null;
  classification: string | null;
  scope_estimate: string | null;
  clarity_score: number | null;
  decision: string | null;
  resolved: boolean;
  resolved_by: string | null;
  created_at: string;
}

interface GitHubActivityResponse {
  pull_requests: PullRequest[];
  issue_events: IssueEvent[];
  counts: { open: number; merged: number; closed: number; issues: number };
}

const PR_STATUS_COLORS: Record<string, string> = {
  open: "bg-green-500/20 text-green-400",
  merged: "bg-purple-500/20 text-purple-400",
  closed: "bg-zinc-600/20 text-zinc-500",
};

const VERDICT_COLORS: Record<string, string> = {
  approved: "bg-green-500/20 text-green-400",
  flagged: "bg-yellow-500/20 text-yellow-400",
  rejected: "bg-red-500/20 text-red-400",
};

function linearIssueLabel(url: string): string {
  const m = url.match(/([A-Z]+-\d+)/);
  return m ? m[1] : "Linear";
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-400">{label}</div>
    </div>
  );
}

function GitHubPageInner() {
  const { setCurrentPage } = usePageContext();
  const [data, setData] = useState<GitHubActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setCurrentPage({ route: "/github", title: "GitHub" });
    return () => setCurrentPage(null);
  }, [setCurrentPage]);

  const fetchData = useCallback(async () => {
    try {
      const res = await inboxGet("/api/github/activity", {
        signal: AbortSignal.timeout(8000),
      });
      const json: GitHubActivityResponse = await res.json();
      setData(json);
    } catch {
      // silent — retry on interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="h-8 w-64 rounded bg-surface-raised animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-lg bg-surface-raised animate-pulse" />
      </div>
    );
  }

  const prs = data?.pull_requests ?? [];
  const issues = data?.issue_events ?? [];
  const counts = data?.counts ?? { open: 0, merged: 0, closed: 0, issues: 0 };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">GitHub</h1>
        <p className="text-sm text-zinc-400">
          Agent-authored pull requests and inbound issue activity. Read-only — actions happen on GitHub.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Open PRs" value={counts.open} />
        <StatTile label="Merged" value={counts.merged} />
        <StatTile label="Closed" value={counts.closed} />
        <StatTile label="Issue events" value={counts.issues} />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Pull Requests</h2>
        {prs.length === 0 ? (
          <p className="text-sm text-zinc-500">No agent-authored pull requests yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">PR</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Repo</th>
                  <th className="px-4 py-2 font-medium">Linked issue</th>
                  <th className="px-4 py-2 font-medium">Review</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {prs.map((pr) => (
                  <tr key={pr.id} className="hover:bg-surface-raised/50">
                    <td className="px-4 py-2">
                      {pr.github_pr_url ? (
                        <a
                          href={pr.github_pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:underline"
                        >
                          {pr.github_pr_number ? `#${pr.github_pr_number} ` : ""}
                          {pr.title}
                        </a>
                      ) : (
                        <span>{pr.title}</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          PR_STATUS_COLORS[pr.status] ?? "bg-zinc-500/20 text-zinc-400"
                        }`}
                      >
                        {pr.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-zinc-400">{pr.target_repo || "—"}</td>
                    <td className="px-4 py-2">
                      {pr.linear_issue_url ? (
                        <a
                          href={pr.linear_issue_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-300 hover:underline"
                        >
                          {linearIssueLabel(pr.linear_issue_url)}
                        </a>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {pr.reviewer_verdict ? (
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${
                            VERDICT_COLORS[pr.reviewer_verdict] ?? "bg-zinc-500/20 text-zinc-400"
                          }`}
                        >
                          {pr.reviewer_verdict}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-500">{timeAgo(pr.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recent Issue Activity</h2>
        {issues.length === 0 ? (
          <p className="text-sm text-zinc-500">No recent GitHub issue activity.</p>
        ) : (
          <div className="space-y-2">
            {issues.map((ev) => (
              <div
                key={ev.id}
                className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-4 py-2"
              >
                <div className="min-w-0">
                  {ev.source_issue_url ? (
                    <a
                      href={ev.source_issue_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                    >
                      {ev.title || "Untitled issue"}
                    </a>
                  ) : (
                    <span>{ev.title || "Untitled issue"}</span>
                  )}
                  <div className="text-xs text-zinc-500">
                    {[ev.classification, ev.scope_estimate, ev.decision]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {ev.resolved ? (
                    <span className="rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                      resolved
                    </span>
                  ) : (
                    <span className="rounded bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400">
                      open
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">{timeAgo(ev.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function GitHubPage() {
  return (
    <Suspense fallback={null}>
      <GitHubPageInner />
    </Suspense>
  );
}
