# SPEC Addendum — Pending Changes for v0.8.0

> **Target spec version:** v0.8.0
> **Addendum started:** 2026-03-07
> **Last updated:** 2026-03-07
> **Status:** ACCUMULATING
> **How to use:** Each section references the spec section it modifies.
>   When ready to merge, apply each section to the corresponding
>   location in SPEC.md.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-03-07 | §7 AMEND | Gradual context poisoning defenses — thread trust decay, per-thread behavioral baseline, instruction category classification |
| 2026-03-07 | §8 AMEND | New threat class `TRUST_ESCALATION_PATTERN` added to threat taxonomy |
| 2026-03-07 | §12 AMEND | `thread_trust` table added to `autobot_comms` schema |

---

## §7 Communication Gateway (AMEND)

> **Source:** 2026-03-07 session — gradual context poisoning threat analysis
> **Spec section affected:** §7 (Communication Gateway — Inbound Processing, Gateway Schema)
> **Change type:** AMEND
> **Board decision:** Approved 2026-03-07. Implement all three layers in Phase 1 with strict gates; use Phase 1 operational data to calibrate thresholds before Phase 2 autonomy expansion.

### Background

The spec's existing inbound defenses (§7 deterministic sanitizer, §5 content sanitization, §8 threat memory) all operate per-message. They are insufficient against gradual context poisoning — a multi-touch attack class where each individual message passes all sanitization checks, but the sequence collectively constructs a trust context that enables a malicious terminal instruction.

The attack exploits a fundamental property of LLM context processing: accumulated cooperative context functions as an implicit trust signal that lowers the rejection threshold for later instructions. Each legitimate exchange shifts the model's behavioral baseline. The attack IS the sequence — there is no single artifact to flag.

This attack class is especially high-risk for agentic email systems because:
1. Thread context accumulation is the core value proposition — you cannot disable it
2. Each message is structurally clean — per-message classifiers produce zero signal
3. The user reinforces the attack passively by engaging with early messages
4. The terminal instruction arrives in a trust context the system built legitimately

### Defense Layer 1: Thread-Level Trust Decay

Add `thread_trust` table to `autobot_comms` schema (see §12 addendum entry for DDL). The Gateway maintains a per-thread trust score that:

- Starts at a configurable baseline (default: 0.5) for new senders
- Increments slightly on each message that passes sanitization cleanly
- Decrements significantly on any sanitization flag or anomaly
- Decays slowly toward baseline over time without user interaction (trust is not permanently earned)
- **Resets review requirement on any `NOVEL_TASK`, `SCOPE_EXPANSION`, or `META_INSTRUCTION` regardless of current score** — this is the key property; the poisoning attack's endgame always involves one of these categories

Trust score is infrastructure-managed (P2). No agent reads or modifies it directly.

### Defense Layer 2: Per-Thread Behavioral Baseline (Inbound)

The spec's §8 Tier 2 behavioral drift detection already applies statistical baselines to *agent output* behavior. This extends the same methodology to *inbound message behavior* per sender/thread.

The Gateway's deterministic sanitizer (step 2 of the inbound pipeline) maintains a behavioral fingerprint per sender:
- Typical request types (read tasks, write tasks, external actions)
- Typical instruction complexity (simple lookups vs. multi-step workflows)
- Historical scope of capabilities requested

If a message represents a significant departure from this baseline — particularly an escalation in **capability scope requested** — it is flagged before any LLM processes it. This analysis is entirely deterministic (statistical comparison against stored fingerprint), consistent with P4.

Baseline deviations exceeding 2σ on capability scope dimension write a `TRUST_ESCALATION_PATTERN` event to `threat_memory` and route the message to human review.

### Defense Layer 3: Instruction Category Classification at Inbound

Extend step 3 of the inbound pipeline (structured extractor) to add `instruction_category` as a classification output alongside the existing sender, category, request summary, and sentiment fields.

**Instruction categories:**

| Category | Description | Review Gate |
|----------|-------------|-------------|
| `INFO_REQUEST` | Read-only — asking for information or status | None beyond standard sanitization |
| `ESTABLISHED_TASK` | Task type this sender has successfully requested before, within established scope | None beyond standard sanitization |
| `NOVEL_TASK` | Task type not in this sender's history, regardless of content | Human review required — first instance per sender per category |
| `SCOPE_EXPANSION` | Requesting capabilities beyond what this sender has previously been granted | Human review required always |
| `META_INSTRUCTION` | Attempting to modify agent behavior, prompts, workflows, or rules | Human review required always + write to `threat_memory` as `INJECTION_ATTEMPT` |

`NOVEL_TASK`, `SCOPE_EXPANSION`, and `META_INSTRUCTION` route to human review **regardless of trust score and regardless of message content**. The classification runs in the deterministic sanitizer layer (step 2) before any LLM touches the message (P2: infrastructure enforces).

The poisoning attack's terminal step always falls into one of these three categories. Requiring explicit human approval for any sender's first instance of each category breaks the attack at its necessary conclusion.

**Phase 1 behavior:** Since Phase 1 operates in suggest mode with board approval of all DIRECTIVEs, the `NOVEL_TASK` → human review gate is low-friction. Everything goes to board review anyway. Phase 1 operational data (what % of `NOVEL_TASK` flags are genuinely novel vs. false positives) will calibrate thresholds before Phase 2 gates are relaxed.

### Updated Inbound Processing Pipeline

Replace the existing 5-step inbound pipeline description with:

1. **Channel receiver** (SES, Twilio webhook, Slack events, etc.)
2. **Deterministic sanitizer** — strips HTML, Unicode control characters, known injection patterns. Checks message against per-thread behavioral baseline (Layer 2). Classifies `instruction_category` (Layer 3). NOT an LLM.
3. **Structured extractor** — a separate small model extracts sender, category, request summary, sentiment, and `instruction_category`. The receiving agent NEVER sees the raw inbound message — only the structured extraction.
4. **Sender verification** — SPF/DKIM/DMARC for email, phone match for SMS, crypto identity for privileged senders
5. **Trust gate** — evaluates `thread_trust.trust_score` + `instruction_category`. Routes `NOVEL_TASK`, `SCOPE_EXPANSION`, `META_INSTRUCTION` to human review queue regardless of trust score.
6. **Intent classifier** — routes to existing task or creates new task in the task graph (only reached if trust gate passes)

### Phase Activation

All three layers active in Phase 1. Gates are strict (lean toward human review). Phase 1 operational data calibrates:
- Trust score increment/decrement weights
- `NOVEL_TASK` false positive rate and threshold tuning
- Behavioral baseline 2σ sensitivity

Thresholds are stored in `tolerance_config` (board-managed, §8) — not hardcoded. Relaxed for Phase 2 based on measured false positive rates.

### Measurement (P5)

Track from Phase 1 day one:

| Metric | Target | Purpose |
|--------|--------|---------|
| `NOVEL_TASK` false positive rate | < 20% by end of Phase 1 | Calibrate threshold before Phase 2 relaxation |
| `TRUST_ESCALATION_PATTERN` events per week | Establish baseline | Detect if attack class is active in the wild |
| Trust gate human review queue depth | < 4 hours median review time | Ensure gate doesn't become a backlog |
| `META_INSTRUCTION` detection rate | 100% of synthetic red-team injections | Validate classifier against adversarial test suite |

Add synthetic `META_INSTRUCTION` and multi-message gradual escalation sequences to the existing adversarial test suite (§5 sanitization testing methodology).

### Ecosystem References

- Simon Willison's Lethal Trifecta framework (already in spec §2) — this attack class specifically exploits the inbound channel component, the highest-risk component
- General social engineering literature: multi-touch attacks where no single message is the payload

---

## §8 Audit and Observability (AMEND)

> **Source:** 2026-03-07 session — gradual context poisoning threat analysis
> **Spec section affected:** §8 (Threat Detection Memory — threat_class CHECK constraint and taxonomy table)
> **Change type:** AMEND

### New Threat Class: TRUST_ESCALATION_PATTERN

Add to `threat_memory.threat_class` CHECK constraint:

```sql
CHECK (threat_class IN (
  'INJECTION_ATTEMPT', 'EXFILTRATION_PROBE', 'RESOURCE_ABUSE',
  'SCHEMA_VIOLATION', 'BEHAVIORAL_ANOMALY', 'INTEGRITY_FAILURE',
  'POLICY_VIOLATION', 'UNKNOWN_PATTERN',
  'TRUST_ESCALATION_PATTERN'   -- NEW
))
```

Add to threat taxonomy table in §8:

| Class | Description | Default Severity |
|-------|-------------|-----------------|
| `TRUST_ESCALATION_PATTERN` | Multi-message sequence from a sender/thread trending toward anomalous instruction categories, even if each individual message passes sanitization. Detected by per-thread behavioral baseline (§7 Layer 2). | MEDIUM (escalates to HIGH on 3rd event in same thread within 24h) |

### Tier 2 Extension

Add to Tier 2 AI Auditor responsibilities: cross-thread correlation analysis — identify whether multiple unrelated senders are running coordinated escalation patterns toward the same agent (supply-chain or coordinated campaign detection). Flag to board if ≥ 3 threads from unrelated senders show `TRUST_ESCALATION_PATTERN` events in the same 48-hour window.

---

## §12 Database Architecture (AMEND)

> **Source:** 2026-03-07 session — gradual context poisoning threat analysis
> **Spec section affected:** §12 (autobot_comms schema)
> **Change type:** AMEND

### New Table: `thread_trust`

Add to `autobot_comms` schema:

```sql
CREATE TABLE autobot_comms.thread_trust (
  thread_id               TEXT PRIMARY KEY,
  sender_id               TEXT NOT NULL REFERENCES autobot_comms.contact_registry(id),
  trust_score             NUMERIC(4,3) NOT NULL DEFAULT 0.500
                            CHECK (trust_score >= 0.0 AND trust_score <= 1.0),
  message_count           INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  anomaly_count           INTEGER NOT NULL DEFAULT 0 CHECK (anomaly_count >= 0),
  novel_request_count     INTEGER NOT NULL DEFAULT 0 CHECK (novel_request_count >= 0),
  -- Tracks which instruction categories this sender has used before
  -- JSONB: { "INFO_REQUEST": 12, "ESTABLISHED_TASK": 4, "NOVEL_TASK": 1, ... }
  category_history_json   JSONB NOT NULL DEFAULT '{}',
  last_user_confirmed_at  TIMESTAMPTZ,   -- last time a human explicitly approved a message in this thread
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trust score adjustments are append-only events for auditability
CREATE TABLE autobot_comms.thread_trust_events (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  thread_id         TEXT NOT NULL REFERENCES autobot_comms.thread_trust(thread_id),
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'message_clean',        -- passed sanitization, no anomalies
                      'message_flagged',      -- sanitization flag or anomaly detected
                      'novel_task_detected',  -- NOVEL_TASK category on this thread
                      'scope_expansion',      -- SCOPE_EXPANSION category
                      'meta_instruction',     -- META_INSTRUCTION category
                      'human_confirmed',      -- board/user approved a message explicitly
                      'decay_tick'            -- scheduled decay without interaction
                    )),
  score_delta       NUMERIC(4,3) NOT NULL,    -- the change applied (+0.010, -0.150, etc.)
  score_after       NUMERIC(4,3) NOT NULL,    -- trust_score value after this event
  inbound_message_id TEXT,                   -- FK to inbound_messages
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash         TEXT                     -- hash chain for tamper detection
  -- Append-only: trigger prevents UPDATE/DELETE
);

-- Default trust score adjustment weights (board-managed via tolerance_config pattern)
-- These are starting values; Phase 1 operational data informs tuning
-- message_clean:       +0.010
-- message_flagged:     -0.150
-- novel_task_detected: -0.100 (also triggers review gate)
-- scope_expansion:     -0.200 (also triggers review gate)
-- meta_instruction:    -0.500 (also triggers review gate + threat_memory write)
-- human_confirmed:     +0.050
-- decay_tick:          -0.005 per 24h without interaction (floor: baseline 0.500)
```

`thread_trust_events` is append-only with hash chain (same pattern as `state_transitions` and `threat_memory`). Trust score adjustments are auditable — every change has a record.

Trust score weights are stored in `tolerance_config` (board-managed), not hardcoded — consistent with the existing graduated escalation threshold management pattern in §8.

### Updated Gateway Schema Table

Add `thread_trust` and `thread_trust_events` to the `autobot_comms` schema table in §7:

| Table | Purpose |
|-------|---------|
| `communication_outbox` | Append-only with hash-chain integrity |
| `inbound_messages` | Normalized inbound with sender verification status |
| `contact_registry` | Known contacts with priority levels and verified channels |
| `templates` | Version-controlled message templates (human-approved) |
| `consent_registry` | Per-user communication preferences and opt-out status |
| `rate_limits` | Current rate limit state per agent, per recipient, global |
| `thread_trust` | Per-thread trust score with decay model (gradual poisoning defense) |
| `thread_trust_events` | Append-only audit log of all trust score changes |

---

*End of SPEC-ADDENDUM-1.md. Next entry will continue the change log above.*
