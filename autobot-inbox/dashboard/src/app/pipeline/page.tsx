import { apiFetch } from "@/lib/api";
import { RetryButton } from "./retry-button";

export const dynamic = "force-dynamic";

const RETRYABLE = new Set(["failed", "timed_out", "blocked"]);

interface WorkItem {
  id: string;
  type: string;
  title: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  message_channel: string | null;
  account_label: string | null;
}

interface Transition {
  id: string;
  work_item_id: string;
  from_state: string;
  to_state: string;
  agent_id: string;
  reason: string | null;
  created_at: string;
}

interface PipelineResponse {
  work_items: WorkItem[];
  events: Record<string, unknown>[];
  transitions: Transition[];
}

const STATUS_COLORS: Record<string, string> = {
  created: "bg-zinc-500/20 text-zinc-400",
  assigned: "bg-blue-500/20 text-blue-400",
  in_progress: "bg-yellow-500/20 text-yellow-400",
  review: "bg-purple-500/20 text-purple-400",
  completed: "bg-green-500/20 text-green-400",
  failed: "bg-red-500/20 text-red-400",
  blocked: "bg-orange-500/20 text-orange-400",
  timed_out: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-600/20 text-zinc-500",
};

export default async function PipelinePage() {
  let work_items: WorkItem[] = [];
  let transitions: Transition[] = [];
  try {
    const data = await apiFetch<PipelineResponse>("/api/debug/pipeline");
    work_items = data.work_items || [];
    transitions = data.transitions || [];
  } catch { /* API timeout or unavailable */ }

  const statusCounts = work_items.reduce(
    (acc, w) => {
      acc[w.status] = (acc[w.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Task Graph Pipeline</h1>

      {/* Status summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Object.entries(statusCounts).map(([status, count]) => (
          <div
            key={status}
            className="bg-surface-raised rounded-lg p-3 border border-white/5"
          >
            <div className="text-xs text-zinc-500 capitalize">{status}</div>
            <div className="text-2xl font-bold">{count}</div>
          </div>
        ))}
      </div>

      {/* Work items table */}
      <section>
        <h2 className="text-lg font-semibold mb-4">
          Recent Work Items ({work_items.length})
        </h2>
        <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-zinc-500">
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Channel</th>
                <th className="text-left p-3">Type</th>
                <th className="text-left p-3">Title</th>
                <th className="text-left p-3">Agent</th>
                <th className="text-left p-3">Created</th>
                <th className="text-left p-3"></th>
              </tr>
            </thead>
            <tbody>
              {work_items.map((w) => (
                <tr key={w.id} className="border-b border-white/5">
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[w.status] || "bg-zinc-500/20 text-zinc-400"}`}
                    >
                      {w.status}
                    </span>
                  </td>
                  <td className="p-3">
                    <ChannelBadge channel={w.message_channel} accountLabel={w.account_label} />
                  </td>
                  <td className="p-3 text-zinc-400">{w.type}</td>
                  <td className="p-3 max-w-xs truncate">{w.title}</td>
                  <td className="p-3 text-zinc-400">
                    {w.assigned_to || w.created_by}
                  </td>
                  <td className="p-3 text-zinc-500 text-xs">
                    <TimeAgo date={w.updated_at || w.created_at} status={w.status} />
                  </td>
                  <td className="p-3">
                    {(RETRYABLE.has(w.status) || isStuck(w)) && (
                      <RetryButton id={w.id} title={w.title} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent transitions */}
      <section>
        <h2 className="text-lg font-semibold mb-4">
          Recent Transitions ({transitions.length})
        </h2>
        <div className="bg-surface-raised rounded-lg border border-white/5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-zinc-500">
                <th className="text-left p-3">Transition</th>
                <th className="text-left p-3">Agent</th>
                <th className="text-left p-3">Reason</th>
                <th className="text-left p-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((t) => (
                <tr key={t.id} className="border-b border-white/5">
                  <td className="p-3">
                    <span className="text-zinc-400">{t.from_state}</span>
                    <span className="mx-1 text-zinc-500">&rarr;</span>
                    <span
                      className={
                        t.to_state === "completed"
                          ? "text-green-400"
                          : t.to_state === "failed"
                            ? "text-red-400"
                            : "text-white"
                      }
                    >
                      {t.to_state}
                    </span>
                  </td>
                  <td className="p-3 text-zinc-400">{t.agent_id}</td>
                  <td className="p-3 text-zinc-500 max-w-xs truncate text-xs">
                    {t.reason || "-"}
                  </td>
                  <td className="p-3 text-zinc-500 text-xs">
                    {new Date(t.created_at).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const ACTIVE_STATES = new Set(["assigned", "in_progress", "created"]);
const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function isStuck(w: WorkItem): boolean {
  if (!ACTIVE_STATES.has(w.status)) return false;
  const age = Date.now() - new Date(w.updated_at || w.created_at).getTime();
  return age > STUCK_THRESHOLD_MS;
}

function TimeAgo({ date, status }: { date: string; status: string }) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let label: string;
  if (days > 0) label = `${days}d ago`;
  else if (hours > 0) label = `${hours}h ago`;
  else if (mins > 0) label = `${mins}m ago`;
  else label = "just now";

  const stuck = ACTIVE_STATES.has(status) && ms > STUCK_THRESHOLD_MS;
  return (
    <span className={stuck ? "text-orange-400 font-medium" : ""}>
      {label}
      {stuck && <span className="ml-1 text-orange-500" title="Stuck in current state">&#9888;</span>}
    </span>
  );
}

function ChannelBadge({ channel, accountLabel }: { channel: string | null; accountLabel: string | null }) {
  if (!channel) return <span className="text-xs text-zinc-500">-</span>;
  const isSlack = channel === "slack";
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium w-fit ${
          isSlack
            ? "bg-purple-500/20 text-purple-400"
            : "bg-blue-500/20 text-blue-400"
        }`}
      >
        {isSlack ? "# Slack" : "\u2709 Email"}
      </span>
      {accountLabel && (
        <span className="text-[10px] text-zinc-500 truncate max-w-[100px]">
          {accountLabel}
        </span>
      )}
    </div>
  );
}
