export { default } from "next-auth/middleware";

export const config = {
  matcher: [
    // Protect all routes except auth API, public signing pages, and static assets
    "/((?!api/auth|sign/|_next/static|_next/image|favicon.ico).*)",
  ],
};

// OPT-88 auth note: the vendored Understand-Anything dashboard lives under
// public/architecture-app/. The matcher above DOES match those paths (they are
// not in the negative-lookahead exclusion list), and this app runs with
// `output: "standalone"` (see next.config.ts) — the standalone Node server routes
// public/ requests through this middleware, so an unauthenticated hit to
// /architecture-app/* is redirected to sign-in. The graph DATA is independently
// gated at /api/architecture/graph (getServerSession → 401). If this board is
// ever moved off Railway standalone to a host that serves public/ from a CDN
// BEFORE middleware (e.g. Vercel edge), move the SPA out of public/ behind an
// auth-gated route — the data route stays safe either way.
