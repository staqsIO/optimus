"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const NAV = [
  { href: "/", label: "Briefing" },
  { href: "/today", label: "Today" },
  { href: "/drafts", label: "Drafts" },
  { href: "/signals", label: "Signals" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/metrics", label: "Metrics" },
  { href: "/stats", label: "Stats" },
  { href: "/finance", label: "Finance" },
  { href: "/system", label: "System" },
  { href: "/audit", label: "Audit" },
  { href: "/contacts", label: "Contacts" },
  { href: "/settings", label: "Settings" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <div className="flex gap-4">
      {NAV.map((n) => {
        const isActive = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            className={`text-sm transition-colors ${
              isActive
                ? "text-white font-medium"
                : "text-zinc-400 hover:text-white"
            }`}
            {...(isActive ? { "aria-current": "page" as const } : {})}
          >
            {n.label}
          </Link>
        );
      })}
    </div>
  );
}
