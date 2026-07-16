import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNNER_UNTRUSTED_CONTENT_AGENTS,
  runnerRequiresModelArmorPreflight,
} from '../src/runtime/runner-model-armor-scope.js';

// GH #495: runner.js used to gate the G8 Model Armor preflight on
// `agentNames.length > 0`, which parseArgs() in runner.js always satisfies (it
// defaults to a non-empty agent list) — so the preflight would fire for EVERY
// runner agent in production. These tests pin the corrected scoping predicate:
// it must require the preflight iff a requested agent actually ingests
// attacker-controllable external content into an LLM. Per the Linus verifier,
// that is exactly issue-triage (GitHub/Linear issue text) and claw-workshop
// (Linear comments → runExecutor with Bash/Write/WebFetch tools).

// Every agent runner.js can be asked to run (must match RUNNER_AGENTS keys in
// src/runner.js). Kept explicit so a drift between this list and RUNNER_AGENTS
// shows up as a failing/stale test rather than silently passing.
const RUNNER_ELIGIBLE_AGENTS = [
  'executor-coder',
  'executor-redesign',
  'executor-blueprint',
  'executor-research',
  'claw-campaigner',
  'claw-workshop',
  'issue-triage',
  'executor-writer',
  'content-atomizer',
  'executor-contract',
];

const UNTRUSTED = ['issue-triage', 'claw-workshop'];

describe('runnerRequiresModelArmorPreflight (GH #495 runner preflight scoping)', () => {
  it('the untrusted-content set is exactly {issue-triage, claw-workshop}', () => {
    assert.deepEqual([...RUNNER_UNTRUSTED_CONTENT_AGENTS].sort(), [...UNTRUSTED].sort());
  });

  it('is TRUE when issue-triage is requested (GitHub/Linear issue text → LLM prompt)', () => {
    assert.equal(runnerRequiresModelArmorPreflight(['issue-triage']), true);
  });

  it('is TRUE when claw-workshop is requested (Linear comments → runExecutor w/ Bash/Write/WebFetch)', () => {
    assert.equal(runnerRequiresModelArmorPreflight(['claw-workshop']), true);
  });

  it('is TRUE when an untrusted-content agent is mixed with safe agents', () => {
    assert.equal(
      runnerRequiresModelArmorPreflight(['executor-coder', 'issue-triage']),
      true
    );
    assert.equal(
      runnerRequiresModelArmorPreflight(['executor-coder', 'claw-workshop']),
      true
    );
  });

  it('is FALSE for the runner default agent set (executor-coder, claw-campaigner)', () => {
    // This is exactly parseArgs()'s default when no --agents= flag is passed —
    // neither default agent consumes untrusted external content, so a production
    // runner on the default set is NOT gated (the old always-true footgun).
    assert.equal(
      runnerRequiresModelArmorPreflight(['executor-coder', 'claw-campaigner']),
      false
    );
  });

  it('is FALSE for every runner-eligible agent that is NOT in the untrusted set', () => {
    for (const agent of RUNNER_ELIGIBLE_AGENTS) {
      if (UNTRUSTED.includes(agent)) continue;
      assert.equal(
        runnerRequiresModelArmorPreflight([agent]),
        false,
        `expected ${agent} to NOT require the G8 preflight`
      );
    }
  });

  it('every untrusted-content agent is itself runner-eligible (set has no dead entries)', () => {
    for (const agent of RUNNER_UNTRUSTED_CONTENT_AGENTS) {
      assert.ok(
        RUNNER_ELIGIBLE_AGENTS.includes(agent),
        `${agent} is in the untrusted set but not a runner-eligible agent`
      );
    }
  });

  it('is FALSE for an empty agent list', () => {
    assert.equal(runnerRequiresModelArmorPreflight([]), false);
  });
});
