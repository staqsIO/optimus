import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Matches bracket placeholders in contract text. Two shapes:
 *   [UPPER_SNAKE]              — legacy, no type metadata
 *   [TYPE:UPPER_SNAKE]         — typed variable; TYPE is one of DATE /
 *                                CURRENCY / SIGNER / TEXT (convention;
 *                                unrecognized types fall back to plain text)
 *
 * The captured group includes the type prefix when present ("DATE:COMMENCEMENT"
 * vs "CLIENT_NAME"), so downstream UI code uses parseBracket() below to split
 * type from name.
 *
 * Max inner length ~80 chars to accommodate TYPE:NAME without runaway.
 */
export const BRACKET_REGEX = /\[([A-Z][A-Z0-9_:]{1,80})\]/g;

/** Types the Variable Panel + AI Bar know how to hint at. Anything else
 *  renders as plain text with the type badge still shown. */
export const KNOWN_VAR_TYPES = ["DATE", "CURRENCY", "SIGNER", "TEXT"] as const;
export type KnownVarType = (typeof KNOWN_VAR_TYPES)[number];

export interface ParsedBracket {
  /** Full inner content, e.g. "DATE:COMMENCEMENT_DATE" or "CLIENT_NAME". */
  raw: string;
  /** Uppercase type prefix if present, null for legacy untyped vars. */
  type: string | null;
  /** The variable name only, e.g. "COMMENCEMENT_DATE" or "CLIENT_NAME". */
  name: string;
}

/** Split "TYPE:name" into parts, or return null type for legacy "NAME". */
export function parseBracket(raw: string): ParsedBracket {
  const m = raw.match(/^([A-Z]+):(.+)$/);
  if (m) return { raw, type: m[1], name: m[2] };
  return { raw, type: null, name: raw };
}

/**
 * Scan a TipTap document and return all unique bracket placeholder names
 * currently present in the text (e.g. ["CLIENT_NAME", "PROPOSAL_NUMBER"]).
 */
export function scanBrackets(doc: PMNode): string[] {
  const names = new Set<string>();
  doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    let match: RegExpExecArray | null;
    const re = new RegExp(BRACKET_REGEX.source, "g");
    while ((match = re.exec(text)) !== null) {
      names.add(match[1]);
    }
  });
  return Array.from(names);
}

/**
 * Find the first occurrence of a bracket placeholder in the document.
 * Returns { from, to } positions or null if not found.
 */
export function findBracketPosition(doc: PMNode, name: string): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  const target = `[${name}]`;
  doc.descendants((node, pos) => {
    if (result || !node.isText || !node.text) return;
    const idx = node.text.indexOf(target);
    if (idx >= 0) {
      result = { from: pos + idx, to: pos + idx + target.length };
      return false;
    }
  });
  return result;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    const re = new RegExp(BRACKET_REGEX.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const from = pos + match.index;
      const to = from + match[0].length;
      decorations.push(
        Decoration.inline(from, to, {
          class: "bracket-var",
          "data-bracket-name": match[1],
        })
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const bracketPluginKey = new PluginKey<DecorationSet>("bracket-decorator");

/**
 * TipTap extension that adds inline decorations to [UPPER_SNAKE] bracket text.
 * Click on a decoration dispatches a "bracket-click" CustomEvent on the editor DOM
 * with detail: { name, from, to }.
 */
export const BracketDecorator = Extension.create({
  name: "bracketDecorator",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: bracketPluginKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return bracketPluginKey.getState(state);
          },
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement | null;
            const el = target?.closest<HTMLElement>("[data-bracket-name]");
            if (!el) return false;
            const name = el.getAttribute("data-bracket-name") || "";
            const found = findBracketPosition(view.state.doc, name);
            if (!found) return false;
            // Select the bracket text so the user can type to replace it inline
            const { tr } = view.state;
            view.dispatch(tr.setSelection(TextSelection.create(view.state.doc, found.from, found.to)));
            // Dispatch bubbling event so the AI bar (or other listeners) can react
            view.dom.dispatchEvent(
              new CustomEvent("bracket-click", {
                detail: { name, from: found.from, to: found.to },
                bubbles: true,
              })
            );
            return true;
          },
        },
      }),
    ];
  },
});
