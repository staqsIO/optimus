# Website Redesign Blueprint

You are redesigning a website homepage. Your output must be a SINGLE self-contained HTML file at `./redesign.html`.

## Context Files (READ ALL BEFORE STARTING)

1. `./original.html` — The original website HTML
2. `./design-brief.md` — Audit scores, improvement targets, strategic design directives
3. `./strategy-brief.md` — Full strategic consulting analysis (business context, conversion architecture)
4. `./business-context.json` — Structured business understanding
5. `./brand.json` — Detected brand colors and identity signals
6. `./seo-head.html` — ALL SEO meta tags from the original (MUST preserve every element)
7. `./image-manifest.md` — Available images with exact URLs (MUST use these, never invent URLs)
8. `./design-system.json` — Validated design system artifact
9. `./component-references.md` — Human-designed component patterns (use as quality references)
10. `./intent-brief.md` — **(only if present)** Visitor-intent landing-page brief. If this file exists, read it FIRST — it changes WHAT you build (see "Intent-Targeted Landing Page Mode" below).

## Phase 1: Research & Understand

1. Read ALL context files listed above
2. Understand the brand identity, business type, target audience, and conversion goals
3. Note the audit scores to beat (design-brief.md § Score Requirements)
4. Review the component references for high-quality patterns to follow

## Phase 2: Generate the Redesign

Create `./redesign.html` following these requirements:

### Intent-Targeted Landing Page Mode (ONLY if `./intent-brief.md` exists)

If `./intent-brief.md` is present, you are NOT producing a faithful redesign of the original
homepage. You are generating a **bespoke landing page recalibrated to a specific visitor's
intent** — the page an agent should serve when it already knows what the visitor wants.

- The hero headline + subhead must speak **directly** to the visitor intent stated in the brief.
- **Foreground the matched products** from the brief as the page's primary content: a prominent
  grid/stack of product cards, each with the product's image (use the exact URL from the brief),
  name, price, a one-line **"why it fits this intent"** benefit you write yourself from the
  product data, and a clear CTA button that links to that product's **real URL** from the brief.
- Order products as given in the brief (best match first). Do not invent products or prices.
- If the brief says no catalog was detected, instead lead with an intent-focused hero and
  reorder/emphasize the existing sections most relevant to the intent — never fabricate products.
- Supporting sections (trust signals, secondary options, FAQ, final CTA) come AFTER the products.
- Everything below — brand identity, images, SEO preservation, accessibility, 2026 design
  directives, score requirements — **still applies unchanged**. Only the page's purpose and
  primary content change.

### Technical Requirements
- Single self-contained HTML file (all CSS inline in `<style>` tags)
- Google Fonts via `<link>` tags (the only allowed external resource)
- Mobile-responsive (CSS Grid/Flexbox, media queries at 375px, 768px, 1440px)
- WCAG AA contrast (4.5:1 text, 3:1 large text)
- NO external CSS files or JS frameworks
- Include attribution footer: "Redesigned by STAQS.IO agents"
- `font-display: swap` on all Google Fonts

### Brand Identity (CRITICAL)
- Read `./brand.json` for detected brand colors
- If `hasClearBranding` is true: use the brand's actual `primaryColors` — do NOT invent a new palette
- The redesign should feel like the same company, just better designed
- Logo, nav, buttons, headings should match the original brand

### Images (CRITICAL)
- Read `./image-manifest.md` for ALL available images with exact URLs
- MUST use the exact `src` URLs from the manifest — NEVER invent, generate, or guess URLs
- Logos (`isLogo=true`): MUST appear in the header
- Hero images (`isHero=true`): Use as hero/banner backgrounds or prominent images
- Every section should have visual content — no empty areas where images belong
- Use `<img>` tags with original alt text and `loading="lazy"`
- NEVER use placeholder URLs, broken URLs, or AI-generated placeholders

### SEO Preservation (NON-NEGOTIABLE)
- Copy EVERY element from `./seo-head.html` into your `<head>` tag
- This includes: title, meta description, canonical, OG tags, hreflang, JSON-LD structured data
- JSON-LD `<script type="application/ld+json">` tags are REQUIRED — they are NOT executable scripts
- You may ADD new structured data (FAQPage) but NEVER remove originals

### 2026 Design Directives
- Scroll-driven animations: `animation-timeline: view()` with `animation-range: entry 10% cover 40%`
- Glassmorphism on nav bar: `backdrop-filter: blur()` with semi-transparent background
- Depth with layered box-shadows (small/medium/large system)
- Break grid symmetry: `1fr 1.3fr` or `2fr 1fr` instead of `repeat(3, 1fr)`
- Spring cubic-bezier `(0.34, 1.56, 0.64, 1)` for hover transitions
- Include `@media (prefers-reduced-motion: reduce)` for accessibility
- Use semantic HTML5: header, nav, main, section, article, footer
- Single H1, proper heading hierarchy

## Phase 3: Self-Verify (REQUIRED)

After generating `redesign.html`, verify it against these checklists. Fix any issues BEFORE reporting completion.

### Accessibility Checklist
- [ ] Skip-to-content link as first `<body>` child
- [ ] ARIA labels on nav, buttons, forms
- [ ] `:focus-visible` styles on all interactive elements
- [ ] Color contrast 4.5:1 for text, 3:1 for large text
- [ ] `alt` text on every `<img>`
- [ ] Proper heading hierarchy (single H1)
- [ ] `<label>` elements on any form inputs

### Performance Checklist
- [ ] No render-blocking resources
- [ ] `font-display: swap` on Google Fonts
- [ ] Explicit `width` and `height` on `<img>` tags
- [ ] Minimal unused CSS rules
- [ ] No excessive DOM depth (< 20 levels)

### SEO Checklist
- [ ] All elements from `seo-head.html` present in `<head>`
- [ ] `<meta name="description">` present
- [ ] `<link rel="canonical">` present
- [ ] Open Graph tags (og:title, og:description, og:image, og:type)
- [ ] JSON-LD structured data (Organization schema minimum)
- [ ] `lang` attribute on `<html>` tag
- [ ] Proper heading hierarchy

### Brand Fidelity Checklist
- [ ] Brand colors used (check against brand.json primaryColors)
- [ ] Typography matches strategy-brief.md § 2.5 font pairing
- [ ] Logo from image-manifest.md used in header
- [ ] All available images used where contextually appropriate

### Design Quality Checklist (avoid "AI look")
- [ ] NOT all 3-column symmetric grids — use asymmetric layouts
- [ ] NOT identical card heights — vary content naturally
- [ ] Scroll-driven animations present on content sections
- [ ] Glassmorphism/depth effects on nav and/or cards
- [ ] Typographic contrast (hero 2.5-4.5rem vs body ~1rem)
- [ ] Spring-physics micro-interactions on hover

If ANY checklist item fails, fix it now. Do not report completion until all checks pass.
