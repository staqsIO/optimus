"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { CommandChip, TreeNode, UploadedFile } from "./types";

export function useCommandBar() {
  const [input, setInput] = useState("");
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [activeChip, setActiveChip] = useState<CommandChip | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const treeLoadedRef = useRef(false);

  // Fetch repo tree on mount
  useEffect(() => {
    if (treeLoadedRef.current) return;
    treeLoadedRef.current = true;
    setTreeLoading(true);
    fetch("/api/workstation/tree")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load file tree"))))
      .then((data) => {
        setTree(data.tree);
        setTreeLoading(false);
      })
      .catch(() => {
        setTreeLoading(false);
      });
  }, []);

  const addContextFile = useCallback((path: string) => {
    setContextFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const removeContextFile = useCallback((path: string) => {
    setContextFiles((prev) => prev.filter((p) => p !== path));
  }, []);

  const addUploadedFile = useCallback((file: UploadedFile) => {
    setUploadedFiles((prev) => [...prev, file]);
  }, []);

  const removeUploadedFile = useCallback((id: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearInput = useCallback(() => {
    setInput("");
    setContextFiles([]);
    setUploadedFiles([]);
  }, []);

  const openFileBrowser = useCallback(() => {
    setFileBrowserOpen(true);
  }, []);

  const closeFileBrowser = useCallback(() => {
    setFileBrowserOpen(false);
  }, []);

  return {
    input,
    setInput,
    contextFiles,
    setContextFiles,
    activeChip,
    setActiveChip,
    fileBrowserOpen,
    openFileBrowser,
    closeFileBrowser,
    addContextFile,
    removeContextFile,
    uploadedFiles,
    addUploadedFile,
    removeUploadedFile,
    clearInput,
    tree,
    treeLoading,
  };
}
