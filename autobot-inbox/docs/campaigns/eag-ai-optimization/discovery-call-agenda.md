# EAG AI Optimization — Discovery Call Agenda
# Duration: 30 minutes
# Purpose: Resolve 6 NEEDS_CLARIFICATION markers blocking Phase 1 entry

---

## Pre-Call: Send Dustin This Context

> We have a complete Phase 1 implementation ready to deploy the moment we confirm your hosting setup. This call is a 30-minute technical intake — six questions that determine which files we place where and how we configure things. Come with Builder.io admin access open if possible.

---

## Agenda (30 min)

### [0:00-0:05] Intro / Goal Alignment
- Confirm: no site redesign, targeted technical optimization only
- Confirm: homepage lead flow remains untouched throughout all phases
- Confirm: EAG advisors available for content review before any page goes live

---

### [0:05-0:20] Technical Intake (6 Questions)

**Q1 — Hosting Provider**
> Who hosts acme-advisors.example? Is it Netlify, Vercel, Cloudflare Pages, Builder.io's native hosting, or something else?

*Why this matters:* robots.txt, llms.txt, and sitemap.xml need to be served from the web root. The hosting provider determines whether we use a static file, a redirect rule, or an edge function. If Builder.io native hosting, we need to evaluate workarounds.

*Decision trigger:*
- Netlify → `netlify.toml` redirect or `public/` static file
- Vercel → `vercel.json` rewrite or `public/` directory
- Cloudflare Pages → `_routes.json` or Workers route
- Builder.io native → custom code injection workaround (may be limited)

---

**Q2 — Framework Integration**
> Is the site using a framework integration like Next.js or Astro with Builder.io as the CMS, or is it Builder.io standalone hosting?

*Why this matters:* Framework integrations allow server-side rendering (SSR) and give us full file system control. Standalone Builder.io hosting is more constrained — JSON-LD injection goes into Builder.io's custom head code, and root-level files may require hosting-layer workarounds.

---

**Q3 — CDN or WAF**
> Is there a Cloudflare account or other CDN/WAF (Fastly, AWS CloudFront) in front of the site?

*Why this matters:* Some Cloudflare bot-fight mode configurations block AI crawlers by default. We need to verify no firewall rules are silently blocking GPTBot, ClaudeBot, PerplexityBot. Takes 10 minutes to check — high upside if there's an active block.

---

**Q4 — Builder.io Admin Access**
> Do you have Builder.io admin access with the ability to:
> - Inject custom code into the `<head>` tag (for JSON-LD and meta tags)?
> - Create new pages/routes (for service pages, FAQ, About)?
> - Publish content?

*Why this matters:* Phase 1 JSON-LD injection requires head tag access. Phase 2 multi-page expansion requires the ability to create new page models in Builder.io. If access is limited, we scope around it.

---

**Q5 — Google Search Console**
> Is Google Search Console currently configured and verified for acme-advisors.example?

*Why this matters:* GSC is required to submit sitemap.xml, monitor indexed pages (SM-5), and track organic impressions (SM-6). If not configured, Phase 1 includes GSC setup — needs DNS access or HTML verification tag.

*Follow-up if NO:* Who controls DNS for acme-advisors.example? (needed for TXT record verification)

---

**Q6 — Current GSC Metrics (if available)**
> If GSC is set up, what's the current monthly organic impression count? (rough number is fine)

*Why this matters:* Sets the SM-6 baseline (2× impressions target within 90 days of Phase 2).

*If not configured yet:* We'll establish baseline after GSC setup in Phase 1.

---

### [0:20-0:25] Content SME Availability
- Confirm process for content review: Which advisor reviews what? (extraction/manufacturing → Maibach? licensing → King?)
- Estimated review turnaround per page: 1-3 business days?
- Will EAG provide any existing materials (proposals, decks, case summaries) that can be adapted for service page content and insights articles?

---

### [0:25-0:30] Next Steps

Based on Q1-Q4 answers:

| Hosting | Next Step After Call |
|---------|---------------------|
| Netlify/Vercel | Phase 1 deploys in 1-2 days — files are ready now |
| Cloudflare Pages | Phase 1 deploys in 1-2 days — slight routing config needed |
| Builder.io native | Phase 1 uses head injection for JSON-LD + meta; root files need evaluation |
| Unknown/other | Need hosting credentials or deploy process walkthrough |

**Immediate actions post-call:**
1. Send Dustin the Phase 1 file package (robots.txt, JSON-LD, meta tags spec)
2. Run baseline AI citation test (20 queries × 4 platforms)
3. Set up GSC if not configured (Dustin action — needs DNS access)
4. Schedule Phase 2 kickoff once Phase 1 EC-1.1 through EC-1.4 pass

---

## Decisions Required (Board-Level)

None in Phase 1 — all Phase 1 changes are reversible technical additions.

Phase 2 decision required: Confirm content review process and advisor availability before page creation begins. Content does NOT go live without advisor sign-off.

---

## Files Ready to Deploy (Pending Hosting Confirmation)

| File | Location | Status |
|------|----------|--------|
| robots.txt | `phase1/robots.txt` | ✅ READY |
| homepage-jsonld.json | `phase1/homepage-jsonld.json` | ✅ READY |
| meta-tags-spec.md | `phase1/meta-tags-spec.md` | ✅ READY |
| llms.txt | `phase2/llms.txt` | ✅ READY (Phase 2) |
| sitemap.xml | `phase2/sitemap.xml` | ✅ READY (Phase 2) |
| Service page outlines | `phase2/service-page-outlines.md` | ✅ READY (Phase 2) |
| Insights article outlines | `phase3/insights-article-drafts.md` | ✅ READY (Phase 3) |
| AI citation tracker | `monitoring/ai-citation-tracker.md` | ✅ READY |
