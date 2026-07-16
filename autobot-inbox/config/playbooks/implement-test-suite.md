---
id: implement-test-suite
name: Implement Test Suite
description: Implement a test suite from a specification document. Tests prove infrastructure enforcement, not prompt compliance.
default_budget_usd: 20
max_turns: 100
session_timeout_ms: 2400000
model: sonnet
output_type: pr
---

# Implement Test Suite

You are implementing a test suite from a specification document committed to the repository.

## Phase 1: Read the Spec

1. Read the test specification file referenced in the issue description (look for a file path under `docs/internal/` or `autobot-spec/`)
2. Understand the test philosophy, categories, and individual test cases
3. Identify which existing code/infrastructure each test exercises

## Phase 2: Assess Current State

1. Read existing tests in `test/` to understand patterns (node:test, assert, mock.module)
2. Check which tests already exist that overlap with the spec
3. Identify infrastructure gaps — do the DB roles, RLS policies, or constraints referenced in the spec exist yet?
4. For tests that require infrastructure not yet built (e.g., JWT per-agent roles, RLS policies), note them as `test.todo()` with a comment explaining what's needed

## Phase 3: Implement Tests

1. Create test files following the existing naming convention (`test/<feature>.test.js`)
2. Use `node:test` with `describe`, `it`, `beforeEach` — match existing patterns
3. Tests should run against the real Docker Postgres (not PGlite) — use `DATABASE_URL` from env
4. For governance tests specifically:
   - Test DB constraints, CHECK clauses, and triggers directly via SQL
   - Test RLS by connecting with different database roles when available
   - Test guardCheck() and transitionState() with adversarial inputs
   - Test immutability by attempting UPDATE/DELETE on append-only tables
5. Each test case from the spec maps to one `it()` block
6. Group by spec category using `describe()` blocks

## Phase 4: Run and Verify

1. Run the full test suite: `cd autobot-inbox && npm test`
2. Ensure all new tests pass
3. Ensure no existing tests break
4. If a test requires infrastructure that doesn't exist yet, use `test.todo('description — requires: <what>')` instead of a failing test

## Phase 5: Create PR

1. Commit with message: `test: implement governance test suite (spec v1.0.0)`
2. Push branch and create PR
3. PR description should list which spec tests are implemented vs. todo

## Constraints

- Do NOT modify production code to make tests pass — tests prove what IS enforced, not what SHOULD be
- Do NOT mock database constraints or RLS — the whole point is testing real infrastructure
- Do NOT skip tests that fail — if a test fails, that's a finding (governance gap), not a bug to fix
- Flag any spec test that cannot be implemented with current infrastructure as a `test.todo()` with clear notes
