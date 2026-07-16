import type { Metadata } from "next";
import SessionProvider from "@/components/SessionProvider";
import SetupBanner from "@/components/SetupBanner";
import NavBar from "@/components/NavBar";
import KillSwitch from "@/components/KillSwitch";
import ElectronDetect from "@/components/ElectronDetect";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoBot Inbox",
  description: "AI inbox management dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <SessionProvider>
        <ElectronDetect />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded"
        >
          Skip to main content
        </a>
        <nav className="app-nav border-b border-white/10 px-6 py-3 flex items-center gap-8">
          <span className="font-bold text-accent-bright tracking-tight">
            AutoBot Inbox
          </span>
          <NavBar />
          <div className="ml-auto flex items-center gap-4">
            <span className="text-xs text-zinc-500">L0 — Full HITL</span>
            <KillSwitch />
          </div>
        </nav>
        <main id="main-content" className="max-w-7xl mx-auto px-6 py-8">
          <SetupBanner />
          {children}
        </main>
        </SessionProvider>
      </body>
    </html>
  );
}
