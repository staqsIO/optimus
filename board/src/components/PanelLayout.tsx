"use client";

/**
 * Three-panel layout.
 *
 * Left: SideNav (collapsible, outside Panel system for reliable toggle)
 * Center: Main content (fills remaining space)
 * Right: Chat panel (collapsible, outside Panel system)
 *
 * No react-resizable-panels on nav/chat — they use simple state toggles
 * for reliable collapse behavior. Center content flexes to fill.
 */

import { ReactNode, useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface PanelLayoutProps {
  left: ReactNode | ((collapsed: boolean, onToggle: () => void) => ReactNode);
  center: ReactNode;
  right?: ReactNode | ((onCollapse: () => void) => ReactNode);
}

// Routes where chat panel should default to collapsed
const CHAT_COLLAPSED_ROUTES = ["/drafts", "/demo"];

// Read initial state from sessionStorage (runs once on mount)
function getStored(key: string, fallback: boolean): boolean {
  try {
    const v = sessionStorage.getItem(key);
    return v !== null ? v === "true" : fallback;
  } catch { return fallback; }
}

export default function PanelLayout({ left, center, right }: PanelLayoutProps) {
  const pathname = usePathname();

  // Global collapse state — persists across views
  const [navCollapsed, setNavCollapsed] = useState(() => getStored("nav-collapsed", false));
  const [chatCollapsed, setChatCollapsed] = useState(() => getStored("chat-collapsed", false));

  // On first load of a CHAT_COLLAPSED_ROUTES page, collapse chat if no stored preference
  useEffect(() => {
    if (!pathname) return;
    const hasPreference = sessionStorage.getItem("chat-collapsed") !== null;
    if (!hasPreference && CHAT_COLLAPSED_ROUTES.some(r => pathname.startsWith(r))) {
      setChatCollapsed(true);
    }
  }, []); // only on mount

  const toggleNav = useCallback(() => {
    setNavCollapsed(prev => {
      const next = !prev;
      try { sessionStorage.setItem("nav-collapsed", String(next)); } catch {}
      return next;
    });
  }, []);

  const toggleChat = useCallback(() => {
    setChatCollapsed(prev => {
      const next = !prev;
      try { sessionStorage.setItem("chat-collapsed", String(next)); } catch {}
      return next;
    });
  }, []);

  // Keyboard shortcut: Ctrl+\ to toggle chat
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "\\") {
        e.preventDefault();
        toggleChat();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleChat]);

  return (
    <div className="flex-1 min-h-0">
      {/* Desktop */}
      <div className="hidden md:flex h-full">
        {/* Left: SideNav */}
        <div className={`${navCollapsed ? "w-[52px]" : "w-[200px]"} shrink-0 h-full transition-[width] duration-200`}>
          {typeof left === "function" ? left(navCollapsed, toggleNav) : left}
        </div>

        {/* Center: Main content — fills remaining space */}
        <div className="flex-1 min-w-0 h-full overflow-hidden border-l border-white/5">
          {center}
        </div>

        {/* Right: Chat (only rendered if right prop is provided) */}
        {right && (chatCollapsed ? (
          <div
            className="w-[20px] shrink-0 h-full border-l border-white/5 bg-zinc-950 flex flex-col items-center justify-center cursor-pointer hover:bg-zinc-900 transition-colors"
            onClick={toggleChat}
            title="Open chat (Ctrl+\)"
          >
            <svg className="w-4 h-4 text-zinc-600 hover:text-zinc-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l-7 7 7 7" />
            </svg>
          </div>
        ) : (
          <div className="w-[380px] shrink-0 h-full border-l border-white/5 overflow-hidden">
            {typeof right === "function" ? right(toggleChat) : right}
          </div>
        ))}
      </div>

      {/* Mobile: single column */}
      <div className="md:hidden flex flex-col h-full">
        <main className="flex-1 overflow-y-auto">{center}</main>
      </div>
    </div>
  );
}
