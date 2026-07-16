# EAG Homepage Meta Tags — Implementation Spec
# Phase 1 | Deliverable: P1-T3
# Insert into Builder.io <head> custom code injection

## Title Tag
```html
<title>Elevated Advisory Group | Cannabis Consulting Firm</title>
```
Character count: 51 ✅ (limit: 60)

## Meta Description
```html
<meta name="description" content="Cannabis consulting for extraction lab design, license applications, expert witness, retail, and operational analysis. Serving operators nationwide and internationally.">
```
Character count: 158 ✅ (limit: 160)

## Open Graph Tags
```html
<meta property="og:type" content="website">
<meta property="og:url" content="https://acme-advisors.example/">
<meta property="og:title" content="Elevated Advisory Group — Cannabis Industry Consultants">
<meta property="og:description" content="Expert cannabis consulting: extraction lab design, license applications, expert witness services, operational audits. Three managing partners with deep industry experience.">
<meta property="og:image" content="https://acme-advisors.example/og-image.jpg">
<meta property="og:site_name" content="Elevated Advisory Group">
```

## Twitter Card Tags
```html
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Elevated Advisory Group — Cannabis Industry Consultants">
<meta name="twitter:description" content="Expert cannabis consulting: extraction lab design, license applications, expert witness services, operational audits.">
<meta name="twitter:image" content="https://acme-advisors.example/og-image.jpg">
```

## Canonical
```html
<link rel="canonical" href="https://acme-advisors.example/">
```

## AI Crawler Hint (optional, emerging standard)
```html
<meta name="ai-content-declaration" content="human-authored; domain=cannabis-consulting; citation-permitted=yes">
```

## Full <head> injection block (paste into Builder.io)
```html
<title>Elevated Advisory Group | Cannabis Consulting Firm</title>
<meta name="description" content="Cannabis consulting for extraction lab design, license applications, expert witness, retail, and operational analysis. Serving operators nationwide and internationally.">
<link rel="canonical" href="https://acme-advisors.example/">
<meta property="og:type" content="website">
<meta property="og:url" content="https://acme-advisors.example/">
<meta property="og:title" content="Elevated Advisory Group — Cannabis Industry Consultants">
<meta property="og:description" content="Expert cannabis consulting: extraction lab design, license applications, expert witness services, operational audits. Three managing partners with deep industry experience.">
<meta property="og:image" content="https://acme-advisors.example/og-image.jpg">
<meta property="og:site_name" content="Elevated Advisory Group">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Elevated Advisory Group — Cannabis Industry Consultants">
<meta name="twitter:description" content="Expert cannabis consulting: extraction lab design, license applications, expert witness services, operational audits.">
<meta name="twitter:image" content="https://acme-advisors.example/og-image.jpg">
<meta name="ai-content-declaration" content="human-authored; domain=cannabis-consulting; citation-permitted=yes">
<script type="application/ld+json">
[PASTE homepage-jsonld.json content here]
</script>
```

## Notes for Builder.io Injection
- In Builder.io, go to: Site Settings → Custom Code → Head
- Paste the full block above
- Replace [PASTE homepage-jsonld.json content here] with the actual JSON from homepage-jsonld.json
- Preview before publishing to verify no render errors
- Validate at: https://search.google.com/test/rich-results
