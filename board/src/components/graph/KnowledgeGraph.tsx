"use client";

/**
 * KnowledgeGraph — Tier 1 Entity-Lens View (OPT-80)
 *
 * Wraps @xyflow/react. Owns canvas, node/edge render, entity search topbar,
 * recency toggle, URL-state wiring, and the EntityInspectorPanel side drawer.
 *
 * Props:
 *   initialEntityId — pre-selected entity from ?entity= URL param (optional)
 *   initialSince    — recency filter from ?since= URL param ("7d" | "30d")
 *
 * Assumptions taken (per spec §5 and board docs):
 *   1. Bundled endpoint — one request per entity returns nodes + edges + inspector.
 *   2. 1-hop only — Tier 2 multi-hop deferred.
 *   3. Summary may be null — "no summary — ask Optimus" CTA displayed.
 *   4. URL state is pushed via router.replace (no history stack pollution).
 */

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import "@xyflow/react/dist/style.css";
import "./graph-styles.css";
import { kgNodeTypes, type KGNodeData } from "./kg-nodes";
import EntityInspectorPanel, {
  type EntityNode,
  type InspectorBundle,
} from "./EntityInspectorPanel";

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  label: string;
  type: string;
}

interface SubgraphResponse {
  focus: EntityNode;
  nodes: Node[];
  edges: Edge[];
  inspector: InspectorBundle;
}

// ── Recency filter ────────────────────────────────────────────────────────────

type SinceFilter = "7d" | "30d";

const SINCE_OPTIONS: { value: SinceFilter; label: string }[] = [
  { value: "30d", label: "All (30d)" },
  { value: "7d", label: "<7d only" },
];

// ── Entity search topbar component ───────────────────────────────────────────

interface EntitySearchProps {
  onSelect: (id: string, label: string) => void;
  since: SinceFilter;
  onSinceChange: (v: SinceFilter) => void;
}

function EntitySearch({ onSelect, since, onSinceChange }: EntitySearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/graph/entity/search?q=${encodeURIComponent(query)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as { results: SearchResult[] };
        setResults(data.results || []);
        setOpen((data.results || []).length > 0);
        setActiveIdx(-1);
      } catch {
        // silently ignore
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      const hit = results[activeIdx];
      if (hit) {
        onSelect(hit.id, hit.label);
        setQuery(hit.label);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const TYPE_COLOR: Record<string, string> = {
    person: "text-indigo-400",
    organization: "text-violet-400",
    topic: "text-amber-400",
  };

  return (
    <div className="flex items-center gap-3 flex-1">
      {/* Search input */}
      <div className="relative flex-1 max-w-xs" role="search" aria-label="Search entities">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="kg-search-listbox"
          aria-activedescendant={
            activeIdx >= 0 ? `kg-result-${activeIdx}` : undefined
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search people, orgs, topics…"
          className="w-full bg-zinc-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 transition-shadow"
        />

        {open && results.length > 0 && (
          <ul
            id="kg-search-listbox"
            role="listbox"
            className="absolute top-full mt-1 w-full bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden z-50"
          >
            {results.map((hit, i) => (
              <li
                key={hit.id}
                id={`kg-result-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                  i === activeIdx
                    ? "bg-white/10 text-zinc-100"
                    : "text-zinc-300 hover:bg-white/5"
                }`}
                onMouseDown={() => {
                  onSelect(hit.id, hit.label);
                  setQuery(hit.label);
                  setOpen(false);
                }}
              >
                <span
                  className={`text-[10px] uppercase font-semibold w-12 flex-shrink-0 ${TYPE_COLOR[hit.type] || "text-zinc-500"}`}
                >
                  {hit.type}
                </span>
                <span className="truncate">{hit.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recency filter */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {SINCE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSinceChange(opt.value)}
            className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
              since === opt.value
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
            }`}
            aria-pressed={since === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface KnowledgeGraphProps {
  initialEntityId?: string;
  initialSince?: SinceFilter;
}

type LoadState = "idle" | "loading" | "error" | "sparse" | "ready";

export default function KnowledgeGraph({
  initialEntityId,
  initialSince = "30d",
}: KnowledgeGraphProps) {
  const router = useRouter();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const [since, setSince] = useState<SinceFilter>(initialSince);
  const [entityId, setEntityId] = useState<string | null>(
    initialEntityId || null
  );
  const [entityLabel, setEntityLabel] = useState<string>("");
  const [focusEntity, setFocusEntity] = useState<EntityNode | null>(null);
  const [inspector, setInspector] = useState<InspectorBundle | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Apply recency fade: edges where both endpoints have recentActivity=false are
  // dimmed when since==="7d"
  const applyRecencyFade = useCallback(
    (rawEdges: Edge[], rawNodes: Node[], active7d: boolean): Edge[] => {
      if (!active7d) return rawEdges;
      const recentIds = new Set(
        rawNodes
          .filter((n) => (n.data as KGNodeData)?.recentActivity)
          .map((n) => n.id)
      );
      return rawEdges.map((e) => {
        const fade =
          !recentIds.has(e.source) && !recentIds.has(e.target);
        return fade
          ? {
              ...e,
              style: {
                ...e.style,
                opacity: 0.15,
              },
            }
          : e;
      });
    },
    []
  );

  // Fetch subgraph for a given entity id
  const fetchEntity = useCallback(
    async (id: string, sinceVal: SinceFilter) => {
      setLoadState("loading");
      setErrorMsg("");
      try {
        const res = await fetch(
          `/api/graph/entity/${encodeURIComponent(id)}?since=${sinceVal}`
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Fetch failed" }));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as SubgraphResponse;

        const processedEdges = applyRecencyFade(
          data.edges,
          data.nodes,
          sinceVal === "7d"
        );

        setNodes(data.nodes);
        setEdges(processedEdges);
        setFocusEntity(data.focus);
        setInspector(data.inspector);
        setLoadState(data.nodes.length <= 1 ? "sparse" : "ready");

        // Open inspector on focus entity by default
        setSelectedNodeId(id);
        setInspectorOpen(true);
      } catch (err) {
        setLoadState("error");
        setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [setNodes, setEdges, applyRecencyFade]
  );

  // Re-fetch when since filter changes and we already have an entity
  useEffect(() => {
    if (!entityId) return;
    fetchEntity(entityId, since);
    // Push URL state
    const params = new URLSearchParams();
    params.set("entity", entityId);
    params.set("since", since);
    router.replace(`/graph?${params.toString()}`, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since, entityId]);

  const handleEntitySelect = useCallback(
    (id: string, label: string) => {
      setEntityId(id);
      setEntityLabel(label);
      setInspectorOpen(false);
    },
    []
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.id === entityId) {
        // Re-focus: open inspector for the focused node
        setSelectedNodeId(node.id);
        setInspectorOpen(true);
      } else {
        // Navigate to the clicked neighbor
        setEntityId(node.id);
        setEntityLabel((node.data as KGNodeData).label ?? node.id);
        setInspectorOpen(false);
      }
    },
    [entityId]
  );

  const handleCloseInspector = useCallback(() => {
    setInspectorOpen(false);
    setSelectedNodeId(null);
  }, []);

  const handleSinceChange = useCallback((v: SinceFilter) => {
    setSince(v);
  }, []);

  // Keyboard: Escape closes inspector
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && inspectorOpen) handleCloseInspector();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOpen, handleCloseInspector]);

  const canvasWidth = inspectorOpen ? "md:w-[calc(100%-360px)]" : "w-full";

  return (
    <div className="w-full h-full flex flex-col bg-surface">
      {/* Topbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 flex-shrink-0">
        <h1 className="text-sm font-semibold text-zinc-300 flex-shrink-0 hidden sm:block">
          Knowledge Graph
        </h1>
        <EntitySearch
          onSelect={handleEntitySelect}
          since={since}
          onSinceChange={handleSinceChange}
        />
      </div>

      {/* Canvas + Inspector */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0">
        {/* ReactFlow canvas */}
        <div
          className={`h-full transition-all duration-200 ease-in-out ${canvasWidth} relative`}
          aria-label="Knowledge graph canvas"
        >
          {/* Empty / Landing state */}
          {loadState === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
              <div className="text-zinc-600 text-4xl" aria-hidden="true">
                ⬡
              </div>
              <p className="text-sm text-zinc-500 max-w-xs">
                Search for a person, organization, or topic above to explore
                their connections.
              </p>
            </div>
          )}

          {/* Loading state */}
          {loadState === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface/80 backdrop-blur-sm z-10">
              <div className="text-sm text-zinc-500 animate-pulse">
                Loading graph…
              </div>
            </div>
          )}

          {/* Error state */}
          {loadState === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-sm text-rose-400">Failed to load graph</p>
              <p className="text-xs text-zinc-500">{errorMsg}</p>
              <button
                onClick={() => entityId && fetchEntity(entityId, since)}
                className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}

          {/* Sparse state — entity exists, 0 connections */}
          {loadState === "sparse" && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10">
              <div className="bg-zinc-800/90 border border-white/10 rounded-lg px-4 py-2.5 text-xs text-zinc-400 text-center shadow-xl">
                <strong className="text-zinc-300 block mb-1">
                  No connections found
                </strong>
                This entity has no recorded relationships yet. Try a broader
                recency window or{" "}
                <a
                  href="/workstation"
                  className="text-indigo-400 hover:underline"
                >
                  ask Optimus
                </a>
                .
              </div>
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={() => {
              // Clicking canvas background closes inspector per spec §3
              handleCloseInspector();
            }}
            nodeTypes={kgNodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            className="bg-surface"
            aria-label="Entity knowledge graph"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="#3f3f46"
            />
            <Controls
              position="bottom-left"
              showInteractive={false}
              aria-label="Graph zoom controls"
            />
            <MiniMap
              nodeColor={(n) => {
                const type = (n.data as KGNodeData)?.entityType;
                if (type === "person") return "#6366f1";
                if (type === "organization") return "#8b5cf6";
                if (type === "topic") return "#f59e0b";
                return "#52525b";
              }}
              maskColor="rgba(24,24,27,0.8)"
              className="!bg-zinc-900/80"
              position="bottom-right"
              aria-label="Graph minimap"
            />
          </ReactFlow>
        </div>

        {/* Inspector side panel — 360px per spec §3 */}
        {inspectorOpen && focusEntity && inspector && (
          <div
            className="w-full md:w-[360px] h-[40vh] md:h-full flex-shrink-0 border-t md:border-t-0 border-white/10 overflow-y-auto"
            aria-label="Entity inspector panel"
          >
            <EntityInspectorPanel
              entity={focusEntity}
              inspector={inspector}
              onClose={handleCloseInspector}
            />
          </div>
        )}
      </div>
    </div>
  );
}
