import type { Metadata } from "next";
import "./globals.css";
import SessionProvider from "@/components/SessionProvider";
import ApiKeyProvider from "@/components/ApiKeyProvider";
import EventStreamProvider from "@/components/EventStreamProvider";
import { ChatSessionProvider } from "@/contexts/ChatSessionContext";
import { PageContextProvider } from "@/contexts/PageContext";
import HeaderBar from "@/components/HeaderBar";
import BoardShell from "@/components/BoardShell";
import CampaignNotifications from "@/components/CampaignNotifications";
import CommandPalette from "@/components/CommandPalette";
import { ToastProvider } from "@/components/Toast";

export const metadata: Metadata = {
  title: "Optimus Board Workstation",
  description: "Governance dashboard for the Optimus agent organization",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased h-screen flex flex-col overflow-hidden">
        <SessionProvider>
          <ApiKeyProvider>
            <EventStreamProvider>
              <ChatSessionProvider>
                <PageContextProvider>
                  <ToastProvider>
                    <HeaderBar />
                    <BoardShell>{children}</BoardShell>
                    <CommandPalette />
                    <CampaignNotifications />
                  </ToastProvider>
                </PageContextProvider>
              </ChatSessionProvider>
            </EventStreamProvider>
          </ApiKeyProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
