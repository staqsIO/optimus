"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface PageInfo {
  route: string;
  title: string;
  entityType?: string;   // 'campaign' | 'project' | 'contact' | 'knowledge-base' | etc.
  entityId?: string;     // specific entity ID when on a detail page
  metadata?: Record<string, unknown>; // page-specific data for chat context
}

interface PageContextType {
  currentPage: PageInfo | null;
  setCurrentPage: (page: PageInfo | null) => void;
  /** Convenience: set page from route + optional entity data */
  setPageFromRoute: (route: string, opts?: { entityType?: string; entityId?: string; metadata?: Record<string, unknown> }) => void;
}

const PageContext = createContext<PageContextType>({
  currentPage: null,
  setCurrentPage: () => {},
  setPageFromRoute: () => {},
});

export function PageContextProvider({ children }: { children: ReactNode }) {
  const [currentPage, setCurrentPage] = useState<PageInfo | null>(null);

  const setPageFromRoute = useCallback((route: string, opts?: { entityType?: string; entityId?: string; metadata?: Record<string, unknown> }) => {
    const title = route === "/" ? "Dashboard" : route.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || "";
    setCurrentPage({
      route,
      title,
      entityType: opts?.entityType,
      entityId: opts?.entityId,
      metadata: opts?.metadata,
    });
  }, []);

  return (
    <PageContext.Provider value={{ currentPage, setCurrentPage, setPageFromRoute }}>
      {children}
    </PageContext.Provider>
  );
}

export function usePageContext() {
  return useContext(PageContext);
}
