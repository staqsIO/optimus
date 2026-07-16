import Link from "next/link";

/** Fetch from inbox API via the server-side proxy (avoids CORS, keeps auth server-side) */
export function inboxGet(path: string, opts?: RequestInit) {
  return fetch(`/api/inbox-proxy?path=${encodeURIComponent(path)}`, opts);
}

export function timeAgo(dateStr: string) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function StatCard({
  label,
  value,
  sub,
  subtitle,
  color,
  href,
  urgent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  subtitle?: string;
  color?: string;
  href?: string;
  urgent?: boolean;
}) {
  const subText = sub || subtitle;
  const inner = (
    <div className={`bg-surface-raised rounded-lg px-4 py-3 border border-white/5 ${urgent ? "border-l-2 border-l-status-action" : ""} ${href ? "hover:border-white/10 transition-colors" : ""}`}>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color || "text-zinc-100"}`}>{value}</div>
      {subText && <div className="text-xs text-zinc-500 mt-0.5">{subText}</div>}
    </div>
  );
  if (href) return <Link href={href}>{inner}</Link>;
  return inner;
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={`px-1.5 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono ${className || ""}`}>
      {children}
    </kbd>
  );
}

const WEBHOOK_DOMAINS: Record<string, { name: string; domain: string }> = {
  tldv: { name: "tl;dv", domain: "tldv.io" },
  github: { name: "GitHub", domain: "github.com" },
  stripe: { name: "Stripe", domain: "stripe.com" },
};

export function ChannelPill({ channel, webhookSource }: { channel?: string; webhookSource?: string | null }) {
  if (!channel) return null;

  // Webhook with known source: show favicon
  if (channel === "webhook" && webhookSource) {
    const source = WEBHOOK_DOMAINS[webhookSource];
    if (source) {
      return (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-500/20 text-emerald-400 inline-flex items-center gap-1"
          title={source.name}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://www.google.com/s2/favicons?domain=${source.domain}&sz=16`}
            alt={source.name}
            width={12}
            height={12}
            className="inline-block"
          />
        </span>
      );
    }
  }

  const config: Record<string, { bg: string; icon: string }> = {
    slack: { bg: "bg-purple-500/20 text-purple-400", icon: "#" },
    webhook: { bg: "bg-emerald-500/20 text-emerald-400", icon: "\u{1F4C4}" },
    email: { bg: "bg-blue-500/20 text-blue-400", icon: "\u2709" },
  };
  const c = config[channel] || config.email;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${c.bg}`}>
      {c.icon}
    </span>
  );
}
