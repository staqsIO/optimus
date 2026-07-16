"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Toast types
// ---------------------------------------------------------------------------

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, duration?: number) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Toast icon per type
// ---------------------------------------------------------------------------

function ToastIcon({ type }: { type: ToastType }) {
  const cls = "w-4 h-4 shrink-0";
  switch (type) {
    case "success":
      return (
        <svg className={`${cls} text-emerald-400`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    case "error":
      return (
        <svg className={`${cls} text-red-400`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    case "warning":
      return (
        <svg className={`${cls} text-amber-400`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3l9.66 16.5H2.34L12 3z" />
        </svg>
      );
    default:
      return (
        <svg className={`${cls} text-blue-400`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// Border color per type
// ---------------------------------------------------------------------------

const borderColor: Record<ToastType, string> = {
  success: "border-l-emerald-500",
  error: "border-l-red-500",
  warning: "border-l-amber-500",
  info: "border-l-blue-500",
};

// ---------------------------------------------------------------------------
// Provider + render
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", duration = 4000) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-4), { id, message, type, duration }]); // max 5
      setTimeout(() => removeToast(id), duration);
    },
    [removeToast]
  );

  const value: ToastContextValue = {
    toast: addToast,
    success: (msg) => addToast(msg, "success", 3000),
    error: (msg) => addToast(msg, "error", 6000),
    info: (msg) => addToast(msg, "info", 4000),
    warn: (msg) => addToast(msg, "warning", 5000),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast container — bottom-right, above the chat input */}
      <div className="fixed bottom-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-zinc-900 border border-white/10 border-l-2 ${borderColor[t.type]} shadow-lg shadow-black/40 text-sm text-zinc-200 animate-in slide-in-from-right-5 duration-200 max-w-[340px]`}
            role="alert"
          >
            <ToastIcon type={t.type} />
            <span className="flex-1 leading-snug">{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              className="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
