# EAG AI Optimization — Week 1 Execution Checklist

## Track A: Zero-Cost Entity Building (Days 1–3, parallel with blocker resolution)

- [ ] **Google Business Profile** — Claim or create profile for "Elevated Advisory Group" at acme-advisors.example. Category: "Business Management Consultant" + "Cannabis Consulting". Add phone, website, description (use llms.txt blockquote summary as basis).
- [ ] **LinkedIn Company Page** — Verify or create company page. Add all three managing partners as employees. Use same description as GBP.
- [ ] **NCIA directory** — Submit or verify member listing at ncia.org (National Cannabis Industry Association).
- [ ] **WeedWeek directory** — Submit EAG to WeedWeek industry directory.
- [ ] **Crunchbase** — Verify company profile exists with correct URL and description.
- [ ] **Future4200 outreach** — Dustin contacts F4200 editorial/wiki team: request EAG citation in Lab Setup & Equipment Sourcing wiki page as a recommended consulting resource. Target: live within 2 weeks.

---

## Track B: Blocker Resolution (Day 1, 30-minute call)

Answer these 6 questions to unblock Phase 1:

1. Hosting provider for acme-advisors.example? (Netlify / Vercel / Builder.io hosting / Cloudflare Pages / other)
2. Framework integration? (Next.js / Astro / standalone Builder.io)
3. CDN or WAF? (Cloudflare / Fastly / none)
4. Builder.io admin access? (Can Dustin add custom code, create pages, modify settings?)
5. Google Search Console — is it configured? If yes, current impression count?
6. DNS access — who controls DNS for acme-advisors.example?

**Fallback if hosting blocks root files:** Deploy Cloudflare Worker (free tier) to intercept /robots.txt, /llms.txt, /sitemap.xml and return correct content with proper headers. Implementation: ~30 minutes.

---

## Track C: Content Drafting (Days 1–7, does NOT require blocker resolution)

These can be drafted regardless of platform answers:

- [ ] **FAQ page** (content ready — see faq-page-content.md). Needs SME review on Q7 (current state licensing windows) and Q6 (application specifics). Can publish Week 3 after review.
- [ ] **Extraction service page** (content ready — see extraction-service-page.md). Needs SME review for accuracy on cost ranges and equipment specifics. Can publish Week 3 after review.
- [ ] **llms.txt** (draft ready — see llms.txt). Fill in advisor bios/specializations after SME call. Can publish Week 2 draft version.
- [ ] Draft licensing service page (650w) — Q6/Q7/Q8 FAQ answers provide the foundation.
- [ ] Draft expert witness service page (600w) — Q12/Q13 FAQ answers provide the foundation.

---

## Track D: Technical Deployment (Days 4–7, requires blocker resolution)

- [ ] Deploy `robots.txt` (content in robots.txt) via hosting provider static file directory or Cloudflare Worker
- [ ] Inject homepage JSON-LD (content in homepage-json-ld.html) via Builder.io head custom code
- [ ] Add homepage meta tags (title + description in homepage-json-ld.html) via Builder.io page settings
- [ ] Add alt text to all homepage images via Builder.io image settings — describe each image literally
- [ ] Configure Google Search Console — DNS TXT verification method, submit sitemap.xml
- [ ] Validate JSON-LD at search.google.com/test/rich-results — target: 0 errors

---

## Track E: Baseline Measurement (Day 7)

- [ ] Run baseline AI citation test using citation-tracking-sheet.md
- [ ] Queries: all 10 (Set A + Set B) on Perplexity and ChatGPT Search
- [ ] Record results in tracking sheet — expected: 0 citations
- [ ] Save screenshots of each result page

---

## Week 1 Exit Criteria

| Check | Pass Condition |
|-------|---------------|
| Blocker resolution | All 6 NEEDS_CLARIFICATION items answered |
| Entity footprint | GBP + LinkedIn + ≥2 directories submitted |
| Technical (if unblocked) | robots.txt at HTTP 200, JSON-LD 0 errors in Rich Results Test |
| Content pipeline | FAQ draft complete, extraction page complete, 2 additional service pages drafted |
| Baseline | Citation test run, results documented |
| F4200 | Outreach sent |
