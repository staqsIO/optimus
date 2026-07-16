"use client";

import { useState, useCallback } from "react";
import type { TreeNode } from "./types";

const FILE_ICONS: Record<string, string> = {
  ".ts": "\u{1F1F9}",
  ".tsx": "\u{269B}",
  ".js": "\u{1F1EF}",
  ".json": "\u{1F4E6}",
  ".md": "\u{1F4DD}",
  ".sql": "\u{1F5C3}",
  ".css": "\u{1F3A8}",
  ".env": "\u{1F512}",
};

const DEFAULT_EXPANDED = new Set([
  "autobot-spec",
  "autobot-inbox",
  "autobot-inbox/src",
  "dashboard",
  "dashboard/src",
]);

function getFileIcon(name: string): string {
  const ext = name.includes(".") ? "." + name.split(".").pop() : "";
  return FILE_ICONS[ext] || "\u{1F4C4}";
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedPath?: string;
}

function TreeItem({ node, depth, onFileSelect, selectedPath }: TreeItemProps) {
  const [expanded, setExpanded] = useState(DEFAULT_EXPANDED.has(node.path));

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (node.type === "directory") {
    return (
      <div>
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-surface-overlay rounded transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="text-[10px] w-3 text-center">
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                onFileSelect={onFileSelect}
                selectedPath={selectedPath}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <button
      onClick={() => onFileSelect(node.path)}
      className={`flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded transition-colors ${
        isSelected
          ? "bg-accent/15 text-accent-bright"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-surface-overlay"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <span className="text-[10px]">{getFileIcon(node.name)}</span>
      <span className="truncate">{node.name}</span>
    </button>
  );
}

interface FileBrowserProps {
  tree: TreeNode[];
  loading: boolean;
  onFileSelect: (path: string) => void;
  selectedPath?: string;
  mobile?: boolean;
  open?: boolean;
  onClose?: () => void;
}

export default function FileBrowser({
  tree,
  loading,
  onFileSelect,
  selectedPath,
  mobile,
  open,
  onClose,
}: FileBrowserProps) {
  const content = (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Files
        </span>
        {mobile && onClose && (
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-sm"
          >
            &times;
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="px-3 py-4 text-xs text-zinc-600">Loading...</div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-4 text-xs text-zinc-600">No files found</div>
        ) : (
          tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              onFileSelect={onFileSelect}
              selectedPath={selectedPath}
            />
          ))
        )}
      </div>
    </div>
  );

  if (mobile) {
    return (
      <>
        {/* Backdrop */}
        {open && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={onClose}
          />
        )}
        {/* Drawer */}
        <div
          className={`fixed inset-y-0 left-0 w-72 bg-surface-raised border-r border-white/5 z-50 lg:hidden transform transition-transform duration-200 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {content}
        </div>
      </>
    );
  }

  return content;
}
