"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useActionCount } from "@/components/ActionRequired";
import { usePreferences } from "@/hooks/usePreferences";
import { getVisiblePages, NAV_ICONS } from "@/lib/nav-config";

interface SideNavProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function SideNav({ collapsed: collapsedProp, onToggleCollapse }: SideNavProps = {}) {
  const pathname = usePathname();
  const { role } = useCurrentUser();
  const { preferences, updatePreference } = usePreferences();
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = collapsedProp ?? localCollapsed;
  const [mobileOpen, setMobileOpen] = useState(false);
  const actionCount = useActionCount();

  const pinnedSlugs = preferences.pinned_pages || [];
  const { pinned, groups } = getVisiblePages(role, pinnedSlugs);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/");

  const togglePin = (slug: string) => {
    const current = preferences.pinned_pages || [];
    const next = current.includes(slug)
      ? current.filter((s) => s !== slug)
      : [...current, slug];
    updatePreference("pinned_pages", next);
  };

  const renderItem = (slug: string, label: string, showPin = true) => {
    const href = `/${slug}`;
    const isPinned = pinnedSlugs.includes(slug);
    return (
      <div key={slug} className="group relative">
        <Link
          href={href}
          title={collapsed ? label : undefined}
          className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
            isActive(href)
              ? "bg-white/10 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
          } ${collapsed ? "justify-center" : ""}`}
        >
          <span className="shrink-0">{NAV_ICONS[slug] || null}</span>
          {!collapsed && <span className="truncate">{label}</span>}
          {!collapsed && slug === "today" && actionCount > 0 && (
            <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-red-500/20 text-red-300 tabular-nums">
              {actionCount}
            </span>
          )}
        </Link>
        {/* Pin/unpin button — visible on hover */}
        {showPin && !collapsed && (
          <button
            onClick={(e) => { e.preventDefault(); togglePin(slug); }}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-600 hover:text-zinc-300 transition-opacity ${
              isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            title={isPinned ? "Unpin" : "Pin to top"}
          >
            <svg className="w-3 h-3" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </button>
        )}
      </div>
    );
  };

  const navContent = (
    <div className="flex flex-col h-full">
      {/* Spacer — brand is in HeaderBar */}
      <div className="pt-2" />

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
        {/* Pinned group */}
        {pinned.length > 0 && (
          <div>
            {!collapsed && (
              <div className="px-3 mb-1 text-[10px] uppercase tracking-wider text-amber-500/70 font-semibold">
                Pinned
              </div>
            )}
            <div className="space-y-0.5">
              {pinned.map((p) => renderItem(p.slug, p.label))}
            </div>
          </div>
        )}

        {/* Regular groups */}
        {groups.map((group) => (
          <div key={group.title}>
            {!collapsed && (
              <div className="px-3 mb-1 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">
              {group.pages.map((p) => renderItem(p.slug, p.label))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom: Cmd+K hint + collapse toggle */}
      <div className="border-t border-white/5 px-3 py-2 space-y-1">
        {!collapsed && (
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-zinc-600">
            <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-500 font-mono">
              {typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl"}
            </kbd>
            <span>+</span>
            <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-500 font-mono">
              K
            </kbd>
            <span className="ml-1 text-zinc-600">Search</span>
          </div>
        )}
        <button
          onClick={() => onToggleCollapse ? onToggleCollapse() : setLocalCollapsed(!localCollapsed)}
          className="w-full flex items-center justify-center p-1.5 rounded-lg text-zinc-600 hover:text-zinc-400 hover:bg-white/5 transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg className={`w-4 h-4 transition-transform ${collapsed ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7" />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger (visible on small screens) */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="md:hidden fixed top-3 left-3 z-50 p-2 rounded-lg bg-surface-raised border border-white/10 text-zinc-400 hover:text-zinc-200 transition-colors"
        aria-label="Toggle navigation"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          {mobileOpen ? (
            <path d="M18 6L6 18M6 6l12 12" />
          ) : (
            <path d="M3 12h18M3 6h18M3 18h18" />
          )}
        </svg>
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          w-full
          shrink-0 bg-zinc-950 border-r border-white/5 flex flex-col h-full
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[240px]
          ${mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
          max-md:transition-transform max-md:duration-200
          hidden md:flex
          ${mobileOpen ? "!flex" : ""}
        `}
      >
        {navContent}
      </aside>
    </>
  );
}
