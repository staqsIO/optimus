"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Underline } from "@tiptap/extension-underline";
import { Placeholder } from "@tiptap/extension-placeholder";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from "react";
import { BracketDecorator, scanBrackets, findBracketPosition } from "./BracketDecorationPlugin";
import { markdownToHtml } from "@/lib/markdown";
import { opsPost } from "@/lib/ops-api";

interface ContractEditorProps {
  draftId: string;
  content: string;
  readOnly?: boolean;
  onSaveStatusChange?: (status: "idle" | "saving" | "saved" | "error") => void;
  onUsedBracketsChange?: (names: string[]) => void;
}

export interface ContractEditorHandle {
  jumpToBracket: (name: string) => void;
  insertBracket: (name: string) => void;
  replaceBody: (markdown: string) => void;
  undo: () => void;
}

function ContractEditorInner(
  { draftId, content, readOnly = false, onSaveStatusChange, onUsedBracketsChange }: ContractEditorProps,
  ref: React.Ref<ContractEditorHandle>
) {
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const currentDraftIdRef = useRef<string>(draftId);
  const initialHtml = markdownToHtml(content);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Underline,
      Placeholder.configure({ placeholder: "Start writing your contract..." }),
      BracketDecorator,
    ],
    content: initialHtml,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class:
          "prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed focus:outline-none min-h-[300px] px-1",
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const html = ed.getHTML();
        if (html !== lastSavedRef.current) {
          saveDraft(html);
        }
      }, 1500);
    },
  });

  // Save function
  const saveDraft = useCallback(
    async (html: string) => {
      setSaveStatus("saving");
      onSaveStatusChange?.("saving");
      try {
        await opsPost(`/api/content/drafts/${draftId}/body`, { body: html });
        lastSavedRef.current = html;
        setSaveStatus("saved");
        onSaveStatusChange?.("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        setSaveStatus("error");
        onSaveStatusChange?.("error");
      }
    },
    [draftId, onSaveStatusChange]
  );

  // Notify parent of used bracket names
  const emitUsedBrackets = useCallback(() => {
    if (!editor || !onUsedBracketsChange) return;
    onUsedBracketsChange(scanBrackets(editor.state.doc));
  }, [editor, onUsedBracketsChange]);

  // Swap content when draftId changes (useEditor reads content only on mount)
  useEffect(() => {
    if (!editor) return;
    if (currentDraftIdRef.current !== draftId) {
      const newHtml = markdownToHtml(content);
      editor.commands.setContent(newHtml, { emitUpdate: false });
      lastSavedRef.current = editor.getHTML();
      currentDraftIdRef.current = draftId;
      emitUsedBrackets();
    }
  }, [draftId, content, editor, emitUsedBrackets]);

  // Re-emit used brackets on every doc change + initial create
  useEffect(() => {
    if (!editor) return;
    emitUsedBrackets();
    editor.on("update", emitUsedBrackets);
    editor.on("create", emitUsedBrackets);
    return () => {
      editor.off("update", emitUsedBrackets);
      editor.off("create", emitUsedBrackets);
    };
  }, [editor, emitUsedBrackets]);

  // React to readOnly changes
  useEffect(() => {
    if (editor) editor.setEditable(!readOnly);
  }, [readOnly, editor]);

  // Expose imperative methods
  useImperativeHandle(
    ref,
    () => ({
      jumpToBracket(name: string) {
        if (!editor) return;
        const found = findBracketPosition(editor.state.doc, name);
        if (!found) return;
        editor.chain().focus().setTextSelection({ from: found.from, to: found.to }).run();
        // Scroll the selection into view
        const dom = editor.view.domAtPos(found.from);
        const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
      insertBracket(name: string) {
        if (!editor) return;
        editor.chain().focus().insertContent(`[${name}]`).run();
      },
      replaceBody(content: string) {
        if (!editor) return;
        // Flush any pending save timer — we're overwriting anyway
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        // Detect if content is already HTML (from LLM edit) vs markdown (from template)
        const isHtml = /<[a-z][\s\S]*>/i.test(content);
        const newHtml = isHtml ? content : markdownToHtml(content);
        editor.commands.setContent(newHtml, { emitUpdate: false });
        const serialized = editor.getHTML();
        lastSavedRef.current = serialized;
        // Persist immediately so the new body lives in the DB
        saveDraft(serialized);
        emitUsedBrackets();
      },
      undo() {
        editor?.chain().focus().undo().run();
      },
    }),
    [editor, saveDraft, emitUsedBrackets]
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full">
      {!readOnly && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-zinc-800 bg-zinc-900/50 flex-wrap">
          <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Bold (Ctrl+B)">B</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Italic (Ctrl+I)"><em>I</em></ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Underline (Ctrl+U)"><u>U</u></ToolbarButton>

          <div className="w-px h-4 bg-zinc-700 mx-1" />

          <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="Heading 2">H2</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="Heading 3">H3</ToolbarButton>

          <div className="w-px h-4 bg-zinc-700 mx-1" />

          <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Bullet List">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Numbered List">1.</ToolbarButton>

          <div className="w-px h-4 bg-zinc-700 mx-1" />

          <ToolbarButton onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insert Table">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M10 3v18M14 3v18" />
            </svg>
          </ToolbarButton>

          <div className="w-px h-4 bg-zinc-700 mx-1" />

          <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal Rule">―</ToolbarButton>

          <div className="flex-1" />

          <span className={`text-[10px] px-2 ${
            saveStatus === "saving" ? "text-amber-400" :
            saveStatus === "saved" ? "text-emerald-400" :
            saveStatus === "error" ? "text-red-400" :
            "text-zinc-600"
          }`}>
            {saveStatus === "saving" ? "Saving..." :
             saveStatus === "saved" ? "Saved" :
             saveStatus === "error" ? "Save failed" : ""}
          </span>

          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Undo (Ctrl+Z)">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a4 4 0 014 4v0a4 4 0 01-4 4H3" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 6l-4 4 4 4" />
            </svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Redo (Ctrl+Shift+Z)">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a4 4 0 00-4 4v0a4 4 0 004 4h10" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 6l4 4-4 4" />
            </svg>
          </ToolbarButton>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

const ContractEditor = forwardRef(ContractEditorInner);
export default ContractEditor;

function ToolbarButton({ children, onClick, active, title }: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2 py-1 text-xs rounded transition-colors ${
        active ? "bg-amber-500/20 text-amber-300" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}
