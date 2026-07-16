"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface ChatSessionContextType {
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  refreshSessions: () => void;
  sessionVersion: number;
}

const ChatSessionContext = createContext<ChatSessionContextType>({
  activeSessionId: null,
  setActiveSessionId: () => {},
  refreshSessions: () => {},
  sessionVersion: 0,
});

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const refreshSessions = useCallback(() => setSessionVersion((v) => v + 1), []);
  return (
    <ChatSessionContext.Provider
      value={{ activeSessionId, setActiveSessionId, refreshSessions, sessionVersion }}
    >
      {children}
    </ChatSessionContext.Provider>
  );
}

export function useChatSession() {
  return useContext(ChatSessionContext);
}
