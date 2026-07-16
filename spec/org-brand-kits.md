# Org Brand Kits (the "on behalf of" entities)

Source-of-truth for the per-org branding the engagement/proposal/contract generator
uses (STAQPRO-614). Derived from **umbadvisors.com** and **staqs.io** on 2026-06-02.
Formul8 intentionally out of scope for now.

Values marked **(derived)** were pulled from the live sites; **(confirm)** need a
human (Linda/Eric) to verify before contracts go out (legal entity name, registered
address, signing-domain verification, canonical logo file).

This doc becomes a small per-org config record consumed by the selector — see the
proposed shape at the bottom.

---

## STAQS — `org: staqs`

| Field | Value | Source |
|---|---|---|
| Display name | **STAQS.IO** (a.k.a. "Staqs") | derived |
| Legal entity name | _Staqs ___ LLC?_ | **confirm** |
| Tagline | "Agentic Engineering Studio" | derived |
| Positioning line | "We ship production AI in weeks. Not decks. Not demos." | derived |
| **Use when** | software / AI engineering / build & delivery work | derived (disambiguation rule) |
| `kind` | `project` (dev — spawns work_items) | ADR-015 |
| Primary font | **JetBrains Mono** (`wght 400;500;700`) | derived (Google Fonts) |
| Display font | **Handjet** (`wght 900`) — big terminal headers | derived |
| Font stack | `JetBrains Mono, ui-monospace, Cascadia Code, Fira Code, monospace` | derived |
| Aesthetic | terminal / command-line, dark | derived |
| Background | `#050505` (theme-color) / `#0a0a0a` | derived |
| Primary accent | **`#4ade80`** (terminal green) | derived |
| Body text | `#e0e0e0` | derived |
| Status accents | `#ff5f57` red · `#febc2e` amber · `#28c840` green · `#f87171` rose (mac traffic-lights) | derived |
| Logo asset | `staqs.io/favicon.ico`; `staqs.io/og-image.jpg` — **need vector/wordmark** | derived + **confirm** |
| Contact email | `hello@staqs.io` | derived |
| Signing email | `signing@staqs.io` — **domain not yet verified in Resend** | **confirm** |
| Location | New York, NY · global remote | derived |
| Pricing anchor | engagements start at $10,000 | derived |
| LinkedIn | linkedin.com/company/staqsio | derived |
| GitHub | github.com/staqsIO | derived |
| Default template | service-proposal / SOW | proposed |

---

## UMB ADVISORS — `org: umb`

| Field | Value | Source |
|---|---|---|
| Display name | **UMB Advisors** | derived |
| Legal entity name | _UMB Advisors LLC?_ | **confirm** |
| Tagline | "Advisory. Technology. Execution." | derived |
| Positioning line | "Senior operators inside your business until growth holds." | derived |
| **Use when** | advisory / consulting / operations / GTM / strategy / fractional-exec work | derived (disambiguation rule) |
| `kind` | `advisory` (relationship-centric — may sit in `active` with zero work_items) | ADR-015 |
| Display / heading font | **Cormorant Garamond** (serif) | derived (Google Fonts) |
| Body font | **DM Sans** (`var(--font-dm-sans)`) | derived |
| Mono / accent font | **JetBrains Mono** | derived |
| Aesthetic | elegant serif + sans, dark navy, gold | derived |
| Background | `#0e1320` / `#0a0e1a` (dark navy) | derived |
| Primary accent | **`#d4af6f`** (gold; secondary `#c9a96e`) | derived |
| Secondary accents | `#34d399` emerald · `#fb7185` rose · `#67e8f9` cyan | derived |
| Body text | `#ededed` | derived |
| Logo asset | `umbadvisors.com/icon.svg` (vector ✓); `umbadvisors.com/opengraph-image` | derived |
| Contact email | `hello@umbadvisors.com` | derived |
| Signing email | `signing@umbadvisors.com` — **verified in Resend** (contract engine) | derived (confirmed) |
| Engagement terms | 90 days minimum; ≤ 6 active engagements | derived |
| Partners (engagement leads / internal signers) | Mike Maibach, Casey Boone, Eric Gang, Dustin Powers, Patrick King — all Managing Partners | derived |
| Registered address | — | **confirm** |
| Default template | service-proposal (advisory) | proposed |

---

## Still needed from Linda/Eric (the **(confirm)** rows)

1. **Legal entity names** for contract party lines (Staqs ___ LLC; UMB Advisors LLC).
2. **Registered business address(es)** for contract boilerplate.
3. **Canonical logo files** (vector wordmark for Staqs; UMB has `icon.svg`).
4. **Staqs signing domain** — verify `signing@staqs.io` in Resend, or decide Staqs
   contracts send from `signing@umbadvisors.com` for now.

---

## Proposed config shape (consumed by STAQPRO-614 selector)

One record per org; `owner_org_id` is the key (resolved from the JWT principal — the
selector never accepts an org from the request body, per ADR-012/M1).

```jsonc
{
  "staqs": {
    "display_name": "STAQS.IO",
    "legal_name": "TBD",
    "kind": "project",
    "use_when": ["software", "ai-build", "engineering"],
    "fonts": { "heading": "Handjet", "body": "JetBrains Mono", "mono": "JetBrains Mono" },
    "colors": { "bg": "#050505", "primary": "#4ade80", "text": "#e0e0e0" },
    "logo": "TBD-vector",
    "contact_email": "hello@staqs.io",
    "signing_email": "signing@staqs.io",   // pending Resend verification
    "default_template": "service-proposal"
  },
  "umb": {
    "display_name": "UMB Advisors",
    "legal_name": "TBD",
    "kind": "advisory",
    "use_when": ["advisory", "consulting", "operations", "gtm", "strategy"],
    "fonts": { "heading": "Cormorant Garamond", "body": "DM Sans", "mono": "JetBrains Mono" },
    "colors": { "bg": "#0e1320", "primary": "#d4af6f", "text": "#ededed" },
    "logo": "https://umbadvisors.com/icon.svg",
    "contact_email": "hello@umbadvisors.com",
    "signing_email": "signing@umbadvisors.com",  // verified
    "default_template": "service-proposal"
  }
}
```
