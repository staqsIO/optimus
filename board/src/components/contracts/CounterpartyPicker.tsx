"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface Counterparty {
  id: string;
  name: string;
  primary_signer_email: string | null;
  contract_count: number;
}

interface CounterpartyPickerProps {
  /** Selected counterparty id, or null if unselected. */
  value: string | null;
  /** Fires with the new id (null to clear). Pass the name too for display convenience. */
  onChange: (id: string | null, name: string | null) => void;
  placeholder?: string;
  /** Disable the control while a contract is being created. */
  disabled?: boolean;
}

/**
 * Searchable counterparty picker with inline create. Hits /api/counterparties
 * on focus and on typing; creates via POST /api/counterparties when the user
 * picks the "Create" option. Backend dedups on case-folded name so re-typing
 * an existing name is idempotent.
 */
export default function CounterpartyPicker({ value, onChange, placeholder = "Client / counterparty", disabled }: CounterpartyPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Counterparty[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hydrate the display name when value is provided externally (e.g., edit mode).
  // Only fire when we have an id but no name cached.
  useEffect(() => {
    if (!value) { setSelectedName(null); return; }
    if (selectedName) return;
    opsFetch<{ counterparties: Counterparty[] }>(`/api/counterparties`).then((d) => {
      const match = d?.counterparties.find((c) => c.id === value);
      if (match) setSelectedName(match.name);
    });
  }, [value, selectedName]);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    const data = await opsFetch<{ counterparties: Counterparty[] }>(
      `/api/counterparties${q ? `?q=${encodeURIComponent(q)}` : ""}`
    );
    setResults(data?.counterparties || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, search]);

  // Close on click outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(c: Counterparty) {
    onChange(c.id, c.name);
    setSelectedName(c.name);
    setQuery("");
    setOpen(false);
  }

  function clear() {
    onChange(null, null);
    setSelectedName(null);
    setQuery("");
  }

  async function createAndPick() {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    const res = await opsPost<{ counterparty_id: string }>("/api/counterparties", { name });
    setCreating(false);
    if (res.ok && res.data?.counterparty_id) {
      onChange(res.data.counterparty_id, name);
      setSelectedName(name);
      setQuery("");
      setOpen(false);
    }
  }

  // An exact case-insensitive match in the current results suppresses the
  // "Create" option — otherwise picking and creating produce the same row.
  const hasExactMatch = results.some(r => r.name.toLowerCase() === query.trim().toLowerCase());
  const showCreate = query.trim().length > 0 && !hasExactMatch;

  // Selected-state display (pill with clear button)
  if (value && selectedName && !open) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg">
        <span className="text-zinc-200 flex-1">{selectedName}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          className="text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
        >
          change
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          className="text-zinc-500 hover:text-red-400 text-sm leading-none disabled:opacity-50"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 disabled:opacity-60"
      />

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 shadow-xl z-20">
          {loading && results.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-zinc-500">Searching...</div>
          )}

          {results.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => pick(c)}
              className="w-full text-left px-3 py-1.5 hover:bg-amber-500/10 focus:bg-amber-500/10 outline-none flex items-center gap-2"
            >
              <span className="text-[12px] text-zinc-200 truncate flex-1">{c.name}</span>
              {c.primary_signer_email && (
                <span className="text-[10px] text-zinc-500 truncate">{c.primary_signer_email}</span>
              )}
              {c.contract_count > 0 && (
                <span className="text-[9px] text-zinc-600 shrink-0">{c.contract_count} contract{c.contract_count === 1 ? "" : "s"}</span>
              )}
            </button>
          ))}

          {!loading && results.length === 0 && !showCreate && (
            <div className="px-3 py-2 text-[11px] text-zinc-500">No counterparties yet — type to create one</div>
          )}

          {showCreate && (
            <button
              type="button"
              onClick={createAndPick}
              disabled={creating}
              className="w-full text-left px-3 py-1.5 border-t border-zinc-800 hover:bg-emerald-500/10 focus:bg-emerald-500/10 outline-none flex items-center gap-2 text-emerald-300 text-[12px] disabled:opacity-60"
            >
              <span>+</span>
              <span>{creating ? "Creating..." : `Create "${query.trim()}"`}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
