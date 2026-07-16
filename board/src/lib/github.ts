export const REPO_OWNER = "staqsIO";
export const REPO_NAME = "optimus";
export const BASE_BRANCH = "main";

export function isValidFilePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("..")) return false;
  if (p.startsWith(".github/")) return false;
  if (p.startsWith(".env") || p.includes("/.env")) return false;
  return /^[a-zA-Z0-9_\-./]+$/.test(p);
}
