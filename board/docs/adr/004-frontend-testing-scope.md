# ADR-004 — Frontend testing scope for v1

**Status:** Accepted
**Date:** 2026-05-11

## Context

The `board/` package has **no test framework** today — no `vitest`, no `jest`, no React Testing Library, no test scripts in `package.json`. Setting up component testing infrastructure (test runner config, JSDOM, RTL, type integration with Next 15 / React 19) is a 1–2 day side-quest with its own decisions (CSR-only vs server components, mocking `inboxGet`, mocking `useEventStream`).

The user asked for TDD discipline on this v1. Strict TDD on UI components would block on the test-infra side-quest.

`autobot-inbox/` has full `node:test` + PGlite test infrastructure (`test/helpers/setup-db.js`) and a working `npm test` script.

## Decision

For v1 we split TDD scope by *what is testable today*:

1. **Backend (`autobot-inbox`):** Full TDD. RED → GREEN → REFACTOR for `GET /api/board`. Uses existing `node:test` + PGlite harness in `autobot-inbox/test/`.

2. **Frontend pure logic (`board/`):** Full TDD on the lane-bucketing function. Located at `board/src/app/board/lanes.ts`, exporting a pure `computeLanes(workItems, proposals, attention)` function. Tests run under `node:test` directly against the TypeScript module (compiled via `tsx` or `ts-node` runner — pick the lightest option). This is testable today *because* it is a pure function with no React, no DOM, no Next runtime.

3. **Frontend rendering (`board/`):** No automated tests in v1. Verified by:
   - `tsc --noEmit` (typecheck)
   - `next build` (build-time correctness)
   - Manual dev-server smoke test against staging data

Rationale: pushing all behaviour worth testing into the pure function means the React shell is a thin renderer — small enough that "verify by running" is cheap and proportionate.

## Consequences

- v1 ships without RTL. A future ADR will introduce component testing when the second piece of complex UI logic appears (the moment we duplicate "verify by running" pain).
- The pure-fn TDD discipline forces a clean seam between data-shaping and rendering. This is the right shape regardless of testing.
- The rendering shell is allowed to be naive: no `useReducer`, no in-page state machines. Anything tempted to grow into that complexity moves into `lanes.ts` and gets tested.
- Code review (final TDD step) is responsible for catching rendering bugs that escape the typecheck/build/smoke triangle.
