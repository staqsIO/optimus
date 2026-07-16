# NB2 Image Generation Integration for Redesign Pipeline

## Context

The redesign pipeline scrapes original site images and tells Claude Code to reuse them. When images are missing (no hero, sparse visuals), it falls back to CSS gradients — the weakest visual outcome. The Nano Banana 2 skill (Gemini 3.1 Flash Image) fills this gap by generating on-brand, strategically-informed images using the business context already extracted in Step 2.1.

**Trigger**: Fill gaps only. Zero-cost for image-rich sites. Max 4 images per job (~$0.16 worst case).
**API**: Gemini API (`@google/generative-ai` npm package). User has `GEMINI_API_KEY` ready.

## Files to Create/Modify

| Action | Path | What |
|--------|------|------|
| **Create** | `src/agents/redesign-imagegen.js` | Gap detection + NB2 prompt builder + Gemini API client (~250 lines) |
| **Modify** | `src/agents/executor-redesign.js` | Insert Step 2.3, update costBreakdown, update design brief with generated image guidance |
| **Modify** | `config/agents.json` | Add `imagegen` config block under `executor-redesign` |
| **Create** | `sql/015-imagegen-permission.sql` | Permission grant for `gemini_image` api_client |
| **Modify** | `.env.example` | Add `GEMINI_API_KEY` |
| **Run** | `npm install @google/generative-ai` | Add Gemini SDK dependency |

## New Module: `src/agents/redesign-imagegen.js`

### Exports

1. **`detectImageGaps(images, businessContext)`** — Pure JS, $0
   - Returns `[]` for image-rich sites (zero-cost path)
   - Gap types:
     - `missing_hero`: No `isHero === true` entry, or all hero images width < 400
     - `no_section_backgrounds`: Total count < 3 AND visual-heavy business type (restaurant, ecommerce, real-estate, agency)
     - `missing_trust_imagery`: `trustSignals.missing` includes `teamPhotos` AND image count < 5
   - **Never generates logos** — AI logos violate brand integrity
   - Max 4 gaps returned (hard cap)

2. **`fillImageGaps(gaps, businessContext, brand, jobDir)`** — Orchestrator
   - For each gap: `buildNB2Prompt()` → `generateImage()` → write PNG → build images.json entry
   - Returns array of new image entries (same schema as scraped images + `isGenerated: true`)
   - 6s delay between API calls (Gemini Tier 1 = 10 RPM)
   - Respects config budget cap from `agents.json`
   - Returns `[]` if `GEMINI_API_KEY` not set (graceful degradation)

3. **`GEMINI_IMAGE_COST_ESTIMATE_USD`** — Constant ($0.04/image)

### Internal functions

- **`buildNB2Prompt(gap, businessContext, brand)`** — Maps business context to NB2 structured prompt schema
  - Uses `businessType` to select subject matter (legal → office, restaurant → food, etc.)
  - Uses `targetEmotion` to drive lighting/mood/color grading
  - Uses `brand.primaryColors` (if `hasClearBranding`) to lock color palette
  - Flattens to tagged string: `[SUBJECT]...[CAMERA]...[LIGHTING]...[COLOR]...[COMPOSITION]...[STYLE]...[NEGATIVE]...`
  - Always includes aggressive negatives: `--no text, watermarks, AI-generated look, plastic skin, distorted faces`

- **`generateImage(prompt, opts)`** — Gemini API wrapper
  - Uses `GoogleGenerativeAI` from `@google/generative-ai`
  - Model: `gemini-2.0-flash-preview-image-generation`
  - Config: `responseModalities: ['TEXT', 'IMAGE']`
  - Extracts base64 `inlineData` from response → `Buffer.from(data, 'base64')`
  - Returns `{ imageBuffer, mimeType, promptUsed }`

### NB2 Prompt Template Strategy

Subject mapping by business type + gap type:

| Business Type | Hero Subject | Section BG |
|--------------|-------------|------------|
| legal | Professional law office, mahogany desk, legal library | Abstract geometric, navy/gold tones |
| saas | Clean workspace, modern interface on screen | Subtle gradient mesh, brand colors |
| healthcare | Modern medical facility, natural light | Soft organic shapes, calming palette |
| restaurant | Elegant table setting, warm ambient lighting, fresh cuisine | Food texture close-up, warm tones |
| ecommerce | Lifestyle product arrangement, clean surface | Subtle pattern, brand-aligned |
| agency | Creative studio workspace, portfolio boards | Dynamic geometric, bold palette |
| real-estate | Modern living space, natural light, staging | Architectural detail, aspirational |
| default | Professional workspace, clean modern interior | Abstract, neutral tones |

Camera/lighting driven by `targetEmotion`:
- authority → hard directional, 85mm, low angle
- warmth → golden hour, 50mm, eye level
- efficiency → clean studio, 35mm wide, neutral
- creativity → dramatic side light, 35mm, dutch angle

## Pipeline Modifications (executor-redesign.js)

### Insert Step 2.3 (after strategy brief, before design brief)

```
Step 2.2 (strategy-brief.md) → Step 2.3 (fill image gaps) → Step 2.5 (design-brief.md)
```

Location: after `writeFileSync(join(jobDir, 'strategy-brief.md'), ...)`, before `const briefLines = ['# Design Brief\n'];`

- Import `{ detectImageGaps, fillImageGaps, GEMINI_IMAGE_COST_ESTIMATE_USD }` from `./redesign-imagegen.js`
- Call `detectImageGaps(scraped.images, businessContext)` — returns `[]` for rich sites
- If gaps found: `requirePermission()` → `fillImageGaps()` → update `images.json` → `logCapabilityInvocation()`
- Wrapped in try/catch — non-fatal (same pattern as AEO audit)
- Add `imagegen: 0` to `costBreakdown` initialization
- Include in `costBreakdown.total` calculation

### Update design brief (Step 2.5)

After the existing "Images (MUST REUSE)" section, add a conditional block:

```
If generated images exist in images.json (isGenerated === true):
  - List each with path and suggested role
  - "These are LOCAL files — reference with relative paths"
  - "Prefer generated images over CSS gradients"
```

Requires re-reading `images.json` after Step 2.3 updates it.

### Update costBreakdown

- Initialize: `{ analyze: 0, generate: 0, imagegen: 0, total: 0 }`
- Total: `costBreakdown.total = costBreakdown.analyze + costBreakdown.generate + costBreakdown.imagegen`

### Update metadata storage

Add `generated_images_count` to the metadata write so the API/dashboard can show it.

## Config Update (agents.json)

Under `executor-redesign`, add sibling to `claudeCode`:

```json
"imagegen": {
  "enabled": true,
  "maxImagesPerJob": 4,
  "maxBudgetUsd": 0.20
}
```

## SQL Migration: `sql/015-imagegen-permission.sql`

```sql
INSERT INTO agent_graph.permission_grants
  (agent_id, resource_type, resource_name, classification, scope, source)
VALUES
  ('executor-redesign', 'api_client', 'gemini_image', 'External-Write', 'google:gemini', 'migration')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;
```

## Environment

- Add `GEMINI_API_KEY=` to `.env.example`
- User adds real key to `.env`
- NOT added to `ALLOWED_ENV_KEYS` (Gemini is called server-side, not by Claude Code CLI)

## Implementation Order

1. `npm install @google/generative-ai`
2. Create `src/agents/redesign-imagegen.js` (gap detection + prompt builder + Gemini client)
3. Modify `executor-redesign.js` (Step 2.3 insertion + cost tracking + design brief update)
4. Modify `config/agents.json` (imagegen config block)
5. Create `sql/015-imagegen-permission.sql`
6. Update `.env.example`

## Verification

1. **Gap detection unit test**: Feed an empty `images` array + restaurant businessContext → should return `missing_hero` + `no_section_backgrounds`
2. **Gap detection zero-cost test**: Feed a rich `images` array with hero + 10 images → should return `[]`
3. **Prompt structure test**: Call `buildNB2Prompt()` for legal/hero → verify `[SUBJECT]...[CAMERA]...` tagged format
4. **Integration test**: Submit a known image-sparse URL → verify generated PNGs in job dir, updated images.json, non-zero `costBreakdown.imagegen`
5. **Graceful degradation**: Unset `GEMINI_API_KEY` → verify pipeline completes normally with no images generated
6. **Lighthouse regression**: Verify generated images don't break performance scores (local files, reasonable size)
