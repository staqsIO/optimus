"use client";

/**
 * Obsidian-style force-directed knowledge graph visualization.
 *
 * Canvas-based for performance. No external deps beyond React (P4).
 * Force simulation: repulsion between all nodes, attraction along edges,
 * center gravity, velocity damping. Interactive: pan, zoom, hover, click.
 */

import { useRef, useEffect, useCallback, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  type: "wiki" | "source" | "concept" | "orphan";
  classification?: string;
  size?: number; // override radius
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "wikilink" | "compiled_from" | "similarity";
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (nodeId: string) => void;
  height?: number;
}

// ── Color palette (Obsidian-inspired) ─────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  wiki: "#a78bfa",       // violet — compiled articles
  source: "#6ee7b7",     // emerald — vault source docs
  concept: "#60a5fa",    // blue — wikilinked concepts (unresolved)
  orphan: "#737373",     // zinc — orphan nodes
};

const NODE_BORDER: Record<string, string> = {
  wiki: "#7c3aed",
  source: "#059669",
  concept: "#2563eb",
  orphan: "#525252",
};

const EDGE_COLORS: Record<string, string> = {
  wikilink: "rgba(167, 139, 250, 0.25)",
  compiled_from: "rgba(110, 231, 183, 0.2)",
  similarity: "rgba(255, 255, 255, 0.06)",
};

const CLASSIFICATION_GLOW: Record<string, string> = {
  CONFIDENTIAL: "rgba(239, 68, 68, 0.3)",
  RESTRICTED: "rgba(239, 68, 68, 0.5)",
};

// ── Force simulation constants ────────────────────────────────────────────────

const REPULSION = 800;
const ATTRACTION = 0.005;
const CENTER_GRAVITY = 0.01;
const DAMPING = 0.92;
const MIN_DIST = 30;
const DT = 1;

// ── Component ─────────────────────────────────────────────────────────────────

export default function WikiGraph({ nodes, edges, onNodeClick, height = 500 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const animRef = useRef<number>(0);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: height });

  // Camera state
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number; dragNode: string | null }>({
    dragging: false, lastX: 0, lastY: 0, dragNode: null,
  });

  // Initialize nodes with positions
  useEffect(() => {
    const cx = dimensions.w / 2;
    const cy = dimensions.h / 2;
    nodesRef.current = nodes.map((n, i) => ({
      ...n,
      x: n.x ?? cx + (Math.random() - 0.5) * dimensions.w * 0.6,
      y: n.y ?? cy + (Math.random() - 0.5) * dimensions.h * 0.6,
      vx: 0,
      vy: 0,
      size: n.size ?? (n.type === "wiki" ? 8 : n.type === "source" ? 5 : 4),
    }));
    edgesRef.current = edges;
  }, [nodes, edges, dimensions]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      setDimensions({ w: width, h: height });
    });
    ro.observe(el);
    setDimensions({ w: el.clientWidth, h: height });
    return () => ro.disconnect();
  }, [height]);

  // Screen ↔ world transforms
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const cam = camRef.current;
    return {
      x: (sx - dimensions.w / 2) / cam.zoom - cam.x,
      y: (sy - dimensions.h / 2) / cam.zoom - cam.y,
    };
  }, [dimensions]);

  const findNodeAt = useCallback((wx: number, wy: number): GraphNode | null => {
    const ns = nodesRef.current;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i];
      const dx = (n.x ?? 0) - wx;
      const dy = (n.y ?? 0) - wy;
      const r = (n.size ?? 5) + 4;
      if (dx * dx + dy * dy < r * r) return n;
    }
    return null;
  }, []);

  // Force simulation + render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    function tick() {
      if (!running) return;
      const ns = nodesRef.current;
      const es = edgesRef.current;
      const cam = camRef.current;

      if (ns.length === 0) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      // Build adjacency for edge lookup
      const nodeMap = new Map(ns.map(n => [n.id, n]));

      // Forces
      for (let i = 0; i < ns.length; i++) {
        const a = ns[i];
        // Repulsion (all pairs)
        for (let j = i + 1; j < ns.length; j++) {
          const b = ns[j];
          let dx = (a.x ?? 0) - (b.x ?? 0);
          let dy = (a.y ?? 0) - (b.y ?? 0);
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MIN_DIST) dist = MIN_DIST;
          const force = REPULSION / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx = (a.vx ?? 0) + fx;
          a.vy = (a.vy ?? 0) + fy;
          b.vx = (b.vx ?? 0) - fx;
          b.vy = (b.vy ?? 0) - fy;
        }
        // Center gravity
        a.vx = (a.vx ?? 0) - (a.x ?? 0) * CENTER_GRAVITY;
        a.vy = (a.vy ?? 0) - (a.y ?? 0) * CENTER_GRAVITY;
      }

      // Attraction along edges
      for (const e of es) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;
        const dx = (b.x ?? 0) - (a.x ?? 0);
        const dy = (b.y ?? 0) - (a.y ?? 0);
        const fx = dx * ATTRACTION;
        const fy = dy * ATTRACTION;
        a.vx = (a.vx ?? 0) + fx;
        a.vy = (a.vy ?? 0) + fy;
        b.vx = (b.vx ?? 0) - fx;
        b.vy = (b.vy ?? 0) - fy;
      }

      // Integrate + damp
      for (const n of ns) {
        if (dragRef.current.dragNode === n.id) continue; // skip dragged node
        n.vx = (n.vx ?? 0) * DAMPING;
        n.vy = (n.vy ?? 0) * DAMPING;
        n.x = (n.x ?? 0) + (n.vx ?? 0) * DT;
        n.y = (n.y ?? 0) + (n.vy ?? 0) * DT;
      }

      // ── Render ────────────────────────────────────────────────────────────

      const c = canvas!;
      const g = ctx!;
      const w = dimensions.w;
      const h = dimensions.h;
      const dpr = window.devicePixelRatio || 1;

      c.width = w * dpr;
      c.height = h * dpr;
      c.style.width = w + "px";
      c.style.height = h + "px";
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      g.fillStyle = "#0a0a0a";
      g.fillRect(0, 0, w, h);

      // Subtle grid dots (Obsidian feel)
      g.save();
      g.translate(w / 2, h / 2);
      g.scale(cam.zoom, cam.zoom);
      g.translate(cam.x, cam.y);

      const gridSize = 50;
      const viewLeft = (-w / 2) / cam.zoom - cam.x;
      const viewTop = (-h / 2) / cam.zoom - cam.y;
      const viewRight = (w / 2) / cam.zoom - cam.x;
      const viewBottom = (h / 2) / cam.zoom - cam.y;
      g.fillStyle = "rgba(255,255,255,0.03)";
      for (let gx = Math.floor(viewLeft / gridSize) * gridSize; gx < viewRight; gx += gridSize) {
        for (let gy = Math.floor(viewTop / gridSize) * gridSize; gy < viewBottom; gy += gridSize) {
          g.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }

      // Edges
      for (const e of es) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;

        const isHighlighted = hoveredNode === e.source || hoveredNode === e.target;
        g.beginPath();
        g.moveTo(a.x ?? 0, a.y ?? 0);
        g.lineTo(b.x ?? 0, b.y ?? 0);
        g.strokeStyle = isHighlighted
          ? (e.type === "wikilink" ? "rgba(167,139,250,0.6)" : "rgba(110,231,183,0.5)")
          : EDGE_COLORS[e.type] || "rgba(255,255,255,0.05)";
        g.lineWidth = isHighlighted ? 1.5 : 0.5;
        g.stroke();
      }

      // Nodes
      for (const n of ns) {
        const r = n.size ?? 5;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        const isHovered = hoveredNode === n.id;

        // Classification glow
        const glow = CLASSIFICATION_GLOW[n.classification ?? ""];
        if (glow) {
          g.beginPath();
          g.arc(x, y, r + 6, 0, Math.PI * 2);
          g.fillStyle = glow;
          g.fill();
        }

        // Hover glow
        if (isHovered) {
          g.beginPath();
          g.arc(x, y, r + 8, 0, Math.PI * 2);
          g.fillStyle = "rgba(255,255,255,0.08)";
          g.fill();
        }

        // Node body
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fillStyle = NODE_COLORS[n.type] || "#737373";
        g.fill();
        g.strokeStyle = isHovered ? "#fff" : (NODE_BORDER[n.type] || "#525252");
        g.lineWidth = isHovered ? 1.5 : 0.5;
        g.stroke();

        // Label (only if zoomed in enough or hovered)
        if (cam.zoom > 0.6 || isHovered) {
          const fontSize = Math.max(9, Math.min(12, 10 / cam.zoom));
          g.font = `${isHovered ? "600" : "400"} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = isHovered ? "#f4f4f5" : "rgba(161,161,170,0.7)";

          // Truncate long labels
          let label = n.label;
          if (label.length > 30 && !isHovered) label = label.slice(0, 28) + "...";
          g.fillText(label, x, y + r + 4);
        }
      }

      g.restore();

      // Legend (top-left)
      const legendItems = [
        { color: NODE_COLORS.wiki, label: "Wiki Article" },
        { color: NODE_COLORS.source, label: "Source Doc" },
        { color: NODE_COLORS.concept, label: "Linked Concept" },
      ];
      g.font = "400 10px ui-sans-serif, system-ui, sans-serif";
      g.textAlign = "left";
      g.textBaseline = "middle";
      legendItems.forEach((item, i) => {
        const lx = 12;
        const ly = 16 + i * 18;
        g.beginPath();
        g.arc(lx + 4, ly, 4, 0, Math.PI * 2);
        g.fillStyle = item.color;
        g.fill();
        g.fillStyle = "rgba(161,161,170,0.5)";
        g.fillText(item.label, lx + 14, ly);
      });

      // Node count (top-right)
      g.textAlign = "right";
      g.fillStyle = "rgba(113,113,122,0.4)";
      g.font = "400 10px ui-sans-serif, system-ui, sans-serif";
      g.fillText(`${ns.length} nodes  ${es.length} edges`, w - 12, 16);

      animRef.current = requestAnimationFrame(tick);
    }

    animRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [dimensions, hoveredNode]);

  // ── Mouse handlers ────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wp = screenToWorld(sx, sy);
    const node = findNodeAt(wp.x, wp.y);

    dragRef.current.dragging = true;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    dragRef.current.dragNode = node?.id ?? null;

    if (node) {
      node.vx = 0;
      node.vy = 0;
    }
  }, [screenToWorld, findNodeAt]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wp = screenToWorld(sx, sy);

    // Hover detection
    const node = findNodeAt(wp.x, wp.y);
    setHoveredNode(node?.id ?? null);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = node ? "pointer" : dragRef.current.dragging ? "grabbing" : "grab";
    }

    if (!dragRef.current.dragging) return;

    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;

    if (dragRef.current.dragNode) {
      // Drag node
      const n = nodesRef.current.find(n => n.id === dragRef.current.dragNode);
      if (n) {
        n.x = (n.x ?? 0) + dx / camRef.current.zoom;
        n.y = (n.y ?? 0) + dy / camRef.current.zoom;
        n.vx = 0;
        n.vy = 0;
      }
    } else {
      // Pan camera
      camRef.current.x += dx / camRef.current.zoom;
      camRef.current.y += dy / camRef.current.zoom;
    }
  }, [screenToWorld, findNodeAt]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (dragRef.current.dragNode && !dragRef.current.dragging) return;

    // Click detection (no significant drag)
    const dx = Math.abs(e.clientX - dragRef.current.lastX);
    const dy = Math.abs(e.clientY - dragRef.current.lastY);

    if (dragRef.current.dragNode && dx < 3 && dy < 3 && onNodeClick) {
      onNodeClick(dragRef.current.dragNode);
    }

    dragRef.current.dragging = false;
    dragRef.current.dragNode = null;
  }, [onNodeClick]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    camRef.current.zoom = Math.max(0.2, Math.min(4, camRef.current.zoom * factor));
  }, []);

  if (nodes.length === 0) {
    return (
      <div
        className="bg-[#0a0a0a] border border-white/5 rounded-lg flex items-center justify-center text-zinc-600 text-sm"
        style={{ height }}
      >
        No graph data yet — compile some articles first
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative rounded-lg overflow-hidden border border-white/5">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          dragRef.current.dragging = false;
          dragRef.current.dragNode = null;
          setHoveredNode(null);
        }}
        onWheel={handleWheel}
        style={{ width: dimensions.w, height: dimensions.h, cursor: "grab" }}
      />
      {/* Hovered node tooltip */}
      {hoveredNode && (() => {
        const n = nodesRef.current.find(n => n.id === hoveredNode);
        if (!n) return null;
        const cam = camRef.current;
        const sx = ((n.x ?? 0) + cam.x) * cam.zoom + dimensions.w / 2;
        const sy = ((n.y ?? 0) + cam.y) * cam.zoom + dimensions.h / 2 - 30;
        return (
          <div
            className="absolute pointer-events-none px-2 py-1 rounded bg-zinc-800 border border-white/10 text-xs text-zinc-200 shadow-lg max-w-[200px] truncate"
            style={{ left: sx, top: Math.max(4, sy), transform: "translateX(-50%)" }}
          >
            {n.label}
            {n.classification && n.classification !== "INTERNAL" && (
              <span className="ml-1.5 text-[10px] text-red-300">({n.classification})</span>
            )}
          </div>
        );
      })()}
    </div>
  );
}
