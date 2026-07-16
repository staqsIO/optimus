# Architecture graph (OPT-88 / feature-001)

The board's **Architecture** page (`/architecture`) embeds the
[Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) dashboard
(an interactive code-architecture map of this repo) behind the board's NextAuth
gate. Two vendored pieces back it:

| Artifact | Path | What it is |
|---|---|---|
| Dashboard SPA | `board/public/architecture-app/` | Static Vite bundle (UA plugin **v2.7.7**), built in demo mode with `base=/architecture-app/` and `VITE_GRAPH_URL=/api/architecture/graph`. |
| Graph data | `board/src/data/architecture/knowledge-graph.json` | The graph the dashboard renders, served by the auth-gated route `src/app/api/architecture/graph/route.ts`. |

> The current `knowledge-graph.json` is a **placeholder** — Understand-Anything
> analysing *itself* (97 nodes / 183 edges). Swap in the real optimus graph (see
> below) and it renders unchanged.

## Refresh the graph data (the data file)

The graph is produced by the UA plugin's `/understand` command (a multi-agent
scan; it is not a deterministic CLI):

```
/plugin marketplace add Egonex-AI/Understand-Anything
/plugin install understand-anything
/understand          # writes .understand-anything/knowledge-graph.json at the repo root
npm --prefix board run graph:refresh   # copies it into src/data/architecture/
```

Then commit the updated `knowledge-graph.json` (a `next build` bundles it into
the auth-gated route). Refresh ownership is currently **manual**; a follow-up can
wire it to CI-on-merge or `/understand --auto-update` (feature-001 open question).

## Rebuild the dashboard SPA (rarely — only to bump the UA version)

```
git clone https://github.com/Egonex-AI/Understand-Anything
cd Understand-Anything && pnpm install
cd understand-anything-plugin/packages/dashboard
VITE_GRAPH_URL=/api/architecture/graph \
  npx vite build --config vite.config.demo.ts --base=/architecture-app/
# copy dist/ (minus its bundled knowledge-graph.json) → board/public/architecture-app/
```

The SPA fetches the graph same-origin from `/api/architecture/graph`, so the
board session cookie is sent automatically. This is the *code* architecture graph
— distinct from the operational `/graph` view (agent topology + signals).

## Auth model (read before changing the host)

Two independent gates:

1. **Graph data** — `/api/architecture/graph` does an explicit `getServerSession`
   check (401 without a session). This is the only sensitive surface and is gated
   unconditionally, on any host.
2. **The SPA shell** — vendored under `public/architecture-app/`. The board runs
   with `output: "standalone"` (next.config.ts), and the next-auth `middleware`
   matcher matches `/architecture-app/*`; the standalone Node server routes
   `public/` requests through middleware, so unauthenticated hits are redirected
   to sign-in **on Railway**. The shell is open-source UA code (not secret), but it
   is gated there nonetheless.

> ⚠️ If the board is ever moved to a host that serves `public/` from a CDN/edge
> **before** middleware runs (e.g. Vercel edge), the shell would become
> world-readable (the *data* stays gated). In that case, move the SPA out of
> `public/` and serve it through an auth-gated catch-all route. The data route
> needs no change.
