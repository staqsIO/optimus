## 7. Communication Gateway

### Why a Gateway, Not a Lockdown

v0.1 listed external communication as an "open question" with a default of no external email. OpenClaw's experience demonstrates three failure modes of lockdown:

1. **Goal pressure creates workarounds.** Agents encode messages in API metadata, webhook payloads, or structured outputs. The more you restrict, the more creative and unauditable the workarounds become.
2. **Inability to respond degrades trust.** A company that cannot respond to support tickets, regulatory inquiries, or customer questions is not a functional company.
3. **No audit trail for side channels.** If communication happens through a workaround, there is zero record. A gateway ensures every attempt — successful or rejected — is logged.

### Gateway Architecture

The Gateway is the 5th immutable infrastructure component. Agents submit structured communication intents. The Gateway classifies, sanitizes, scans, and routes messages. Agents never hold communication credentials.

**Outbound processing (risk-tiered release):**

| Tier | Category | Release Mechanism | Latency | Example |
|------|----------|------------------|---------|---------|
| 0 | Transactional | Auto-send | < 200ms | Payment receipt, API confirmation |
| 1 | Operational | Auto-send | < 200ms | Changelog post, status update |
| 2 | Relational | Quorum review (3 agents, 2/3 approval; at least one must be a different model provider + one deterministic rule-based checker) | < 5 min | Support reply, vendor outreach |
| 3 | Reputational | Human-in-the-loop | < 24h SLA | Marketing content, public statement |
| 4 | Legal/Regulatory | Human-in-the-loop + counsel | < 72h SLA | Regulatory response, contract |

**Inbound processing:**

Every inbound message enters through a deterministic pipeline — no LLM touches the raw message:

1. **Channel receiver** (SES, Twilio webhook, Slack events, etc.)
2. **Deterministic sanitizer** — strips HTML, Unicode control characters, known injection patterns. This is NOT an LLM. It is a rule-based parser.
3. **Structured extractor** — a separate small model extracts sender, category, request summary, sentiment. The receiving agent NEVER sees the raw inbound message — only the structured extraction.
4. **Sender verification** — SPF/DKIM/DMARC for email, phone match for SMS, crypto identity for privileged senders (board members, investors authenticate via hardware key or TOTP)
5. **Intent classifier** — routes to existing task or creates new task in the task graph

**Constitutional constraints on communication:**

- Communication cannot create binding obligations (enforced by commitment-language scanner)
- No self-referential communication (outbound to any owned address is blocked)
- Constitutional communication budget (hard daily cap, infrastructure-enforced)
- All outbound includes AI disclosure per FTC Section 5, CA SB 1001, EU AI Act Article 50
- 5-minute cool-down buffer before send (gives kill switch time to activate)

**Gateway schema (`autobot_comms` — isolated):**

| Table | Purpose |
|-------|---------|
| `communication_outbox` | Append-only with hash-chain integrity |
| `inbound_messages` | Normalized inbound with sender verification status |
| `contact_registry` | Known contacts with priority levels and verified channels |
| `templates` | Version-controlled message templates (human-approved) |
| `consent_registry` | Per-user communication preferences and opt-out status |
| `rate_limits` | Current rate limit state per agent, per recipient, global |

Agents have zero write access to `autobot_comms` except through the structured Communication Intent API. The Gateway process has its own database role and credentials.
