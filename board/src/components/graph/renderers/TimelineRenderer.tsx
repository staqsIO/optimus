"use client";

interface TimelineEntry {
  id?: string;
  step_name?: string;
  step_type?: string;
  title?: string;
  description?: string;
  work_item_title?: string;
  status?: string;
  agent_id?: string;
  created_at?: string;
  duration_ms?: number;
  summary?: string | null;
  [key: string]: unknown;
}

interface Props {
  data: unknown;
}

export default function TimelineRenderer({ data }: Props) {
  const items = Array.isArray(data) ? (data as TimelineEntry[]) : [];

  if (items.length === 0) {
    return <div className="text-[10px] text-zinc-600 italic">No activity</div>;
  }

  return (
    <div className="space-y-0">
      {items.slice(0, 20).map((item, i) => {
        const label = item.description || item.step_name || item.work_item_title || item.title || item.status || `Step ${i + 1}`;
        const stepType = item.step_type ? `${item.step_type}` : "";
        const time = item.created_at ? relativeTime(item.created_at) : "";
        const statusColor = getStatusColor(item.status);

        return (
          <div key={item.id || i} className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-0">
            <div className="flex flex-col items-center mt-1">
              <span className={`w-1.5 h-1.5 rounded-full ${statusColor} flex-shrink-0`} />
              {i < items.length - 1 && <span className="w-px h-full bg-white/5 mt-0.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[10px] text-zinc-300 truncate">{label}</span>
                {item.duration_ms != null && (
                  <span className="text-[9px] text-zinc-600 tabular-nums flex-shrink-0">
                    {item.duration_ms > 1000 ? `${(item.duration_ms / 1000).toFixed(1)}s` : `${item.duration_ms}ms`}
                  </span>
                )}
              </div>
              {item.summary && (
                <div className="text-[9px] text-amber-400/80 mt-0.5 truncate">
                  {item.summary}
                </div>
              )}
              <div className="flex items-center gap-1.5 mt-0.5">
                {stepType && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-zinc-500/10 text-zinc-400">{stepType}</span>
                )}
                {item.agent_id && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-500/10 text-indigo-400">{item.agent_id}</span>
                )}
                {time && <span className="text-[9px] text-zinc-600">{time}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getStatusColor(status?: string): string {
  if (!status) return "bg-zinc-600";
  if (status === "completed" || status === "success") return "bg-emerald-500";
  if (status === "failed" || status === "error") return "bg-red-500";
  if (status === "in_progress" || status === "running") return "bg-blue-500";
  if (status === "review") return "bg-amber-500";
  return "bg-zinc-500";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
