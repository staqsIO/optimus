import { marked, type Tokens } from "marked";

// Downshift headings by 2 levels so # → <h3>, ## → <h4>
// Prevents conflict with page <h1> "Board Workstation"
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
  const shifted = Math.min(depth + 2, 6);
  const text = this.parser.parseInline(tokens);
  return `<h${shifted}>${text}</h${shifted}>\n`;
};

marked.setOptions({ renderer, breaks: true });

// Lazy-load DOMPurify to avoid jsdom's CSS file read during Next.js static build
let _DOMPurify: typeof import("isomorphic-dompurify").default | null = null;
function getDOMPurify() {
  if (!_DOMPurify) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _DOMPurify = require("isomorphic-dompurify").default;
  }
  return _DOMPurify!;
}

export function markdownToHtml(md: string): string {
  const raw = marked.parse(md) as string;
  // During SSR/build prerender, skip sanitization — client re-render will sanitize
  if (typeof window === "undefined") return raw;
  return getDOMPurify().sanitize(raw);
}
