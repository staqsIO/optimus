"use client";

import { ReactNode, useEffect } from "react";
import SideNav from "@/components/SideNav";
import PanelLayout from "@/components/PanelLayout";
import { clearChunkReloadGuard } from "@/lib/chunk-recovery";

/**
 * BoardShell: 2-panel layout.
 * Left: SideNav (navigation + controls, collapsible)
 * Center: Page content (Next.js children)
 *
 * Chat moved to dedicated /chat page — no more sidebar.
 */
export default function BoardShell({ children }: { children: ReactNode }) {
  // The shell mounting means chunks loaded successfully — clear the one-time
  // chunk-reload guard so a LATER mid-session deploy can recover again (STAQPRO-544).
  useEffect(() => {
    clearChunkReloadGuard();
  }, []);

  return (
    <PanelLayout
      left={(collapsed, onToggle) => (
        <SideNav collapsed={collapsed} onToggleCollapse={onToggle} />
      )}
      center={<main className="h-full overflow-y-auto">{children}</main>}
    />
  );
}
