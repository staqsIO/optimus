# EAG AI Agent Optimization — Campaign Index
# Status: Phase 1 artifacts READY | Blocked on: discovery call (6 NEEDS_CLARIFICATION)
# Owner: Dustin | Domain: acme-advisors.example | Created: 2026-04-01

---

## Campaign Status

| Phase | Status | Blocker | Entry Criteria |
|-------|--------|---------|----------------|
| Phase 1: Technical Foundation | READY TO DEPLOY | Hosting provider confirmation | Discovery call complete |
| Phase 2: Content Architecture | IN PREPARATION | Phase 1 exit criteria | EC-1.1 through EC-1.4 pass |
| Phase 3: Knowledge Content | IN PREPARATION | Phase 2 exit criteria | EC-2.1 through EC-2.5 pass |

**Immediate next action:** Run discovery call using `discovery-call-agenda.md`

---

## Deliverable Manifest

### Phase 1 Artifacts (deploy immediately after discovery call)
| File | Purpose | Deploys To |
|------|---------|-----------|
| `phase1/robots.txt` | AI crawler permissions | /robots.txt at web root |
| `phase1/homepage-jsonld.json` | Organization + ProfessionalService + WebSite schema | Builder.io <head> injection |
| `phase1/meta-tags-spec.md` | Full <head> block with meta, OG, Twitter Card tags | Builder.io <head> injection |

### Phase 2 Artifacts (create pages + deploy files)
| File | Purpose | Deploys To |
|------|---------|-----------|
| `phase2/llms.txt` | AI crawler content map | /llms.txt at web root |
| `phase2/sitemap.xml` | URL inventory for crawlers | /sitemap.xml at web root |
| `phase2/service-page-outlines.md` | Content briefs for 8 service pages + About + FAQ | Builder.io new pages |

### Phase 3 Artifacts (knowledge content)
| File | Purpose | Deploys To |
|------|---------|-----------|
| `phase3/insights-article-drafts.md` | 5 launch article outlines for SME drafting | /insights/* pages |

### Monitoring
| File | Purpose | Cadence |
|------|---------|---------|
| `monitoring/ai-citation-tracker.md` | AI citation log + GSC + bot activity tracking | Monthly |

---

## Success Metrics Summary

| ID | Metric | Target | Current |
|----|--------|--------|---------|
| SM-1 | AI citation — consulting queries | ≥ 2 of 5 cited | 0 (baseline) |
| SM-2 | AI citation — extraction/lab queries | ≥ 2 of 5 cited | 0 (baseline) |
| SM-3 | Structured data validation | 0 Rich Results errors | N/A (not deployed) |
| SM-4 | llms.txt accessible | HTTP 200 at /llms.txt | 404 (not deployed) |
| SM-5 | GSC indexed pages | ≥ 10 pages | ~1 (single page site) |
| SM-6 | Organic impressions | ≥ 2× baseline (90 days) | TBD at GSC setup |
| SM-7 | AI-attributed leads | ≥ 1/quarter | 0 |

---

## Phase 1 Exit Criteria Checklist

- [ ] EC-1.1: /robots.txt returns HTTP 200 with AI agent rules (`curl https://acme-advisors.example/robots.txt`)
- [ ] EC-1.2: Homepage JSON-LD passes Google Rich Results Test — 0 errors
- [ ] EC-1.3: Google Search Console property verified + sitemap submission queued
- [ ] EC-1.4: Baseline citation test completed (SM-1 and SM-2 first measurement recorded)

---

## Key Contacts
- **Dustin** — Owner, Builder.io access, hosting access, DNS
- **Michael Maibach** — Managing Partner, extraction/manufacturing content review
- **Patrick King** — Managing Partner, licensing content review
- **Casey Boone** — Managing Partner, content review

---

## Future4200 Synergy (Post-Phase 2)
Per §12: after both sites complete Phase 2, coordinate cross-reference — F4200 wiki posts on lab setup should reference EAG as a recommended consulting resource. Highest-leverage citation multiplier in the plan. Flag when EAG Phase 2 exits criteria pass.
