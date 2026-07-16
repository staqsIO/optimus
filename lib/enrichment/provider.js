/**
 * Enrichment Provider Abstraction (OPT-71)
 *
 * Pluggable per-field enrichment layer for contacts and organisations.
 * Mirrors the pattern in lib/llm/provider.js: thin factory + normalizer,
 * no framework.
 *
 * Design:
 *   - Each provider implements the EnrichmentProvider interface (see below).
 *   - The waterfall runner tries providers cheapest-first. For each field
 *     it takes the FIRST provider that returns a value with confidence ≥ threshold.
 *   - Results carry per-field provenance: { value, source, confidence, fetched_at }.
 *     This is the GDPR/CCPA audit trail — every enriched field records where
 *     its value came from and when.
 *   - Providers are gated by required env vars. A missing key → provider is
 *     skipped silently (never throws, never called).
 *
 * Provider interface:
 *   {
 *     name: string,            // stable identifier stored in provenance
 *     isAvailable(): boolean,  // returns false if required env key missing
 *     enrich(entity, { fields }): Promise<EnrichResult>
 *   }
 *
 * EnrichResult shape:
 *   {
 *     fields: {
 *       [fieldName]: {
 *         value: any,
 *         source: string,     // provider name
 *         confidence: number, // 0..1
 *         fetched_at: string, // ISO timestamp
 *       }
 *     }
 *   }
 *
 * Entity shape (contact or org):
 *   {
 *     id: string,
 *     email_address?: string,
 *     name?: string,
 *     owner_org_id?: string,
 *     // ... any existing fields
 *   }
 *
 * Basis for processing (GDPR Art. 6 / CCPA): legitimate interests — enriching
 * contact records for the purpose of providing the Optimus inbox-management
 * service. Provenance recorded per-field so data subjects can exercise
 * right-to-erasure at the field level. External providers are gated OFF
 * by default; no personal data leaves the system unless an explicit API
 * key is configured.
 */

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'enrichment/provider' });

// Minimum confidence a provider must report for a field to be accepted.
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Run the enrichment waterfall.
 *
 * Tries each available provider in order. For each field, takes the first
 * result whose confidence meets the threshold. Never throws — individual
 * provider failures are caught and logged; the field is simply skipped.
 *
 * @param {object} entity           - Contact or org record
 * @param {string[]} fields         - Field names to enrich (e.g. ['title','phone','company'])
 * @param {object[]} providers      - Ordered provider list (cheapest first)
 * @param {object}  [opts]
 * @param {number}  [opts.confidenceThreshold] - Override confidence floor
 * @returns {Promise<EnrichResult>} - Merged per-field result with provenance
 */
export async function runWaterfall(entity, fields, providers, opts = {}) {
  const threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const merged = {};

  const available = providers.filter((p) => {
    if (p.isAvailable()) return true;
    log.debug({ provider: p.name }, 'provider unavailable (no API key) — skipping');
    return false;
  });

  for (const provider of available) {
    // Which fields still need filling?
    const remaining = fields.filter((f) => !merged[f]);
    if (remaining.length === 0) break;

    let result;
    try {
      result = await provider.enrich(entity, { fields: remaining });
    } catch (err) {
      log.warn({ provider: provider.name, err }, 'enrichment provider error — skipping');
      continue;
    }

    const providerFields = result?.fields ?? {};
    for (const field of remaining) {
      const entry = providerFields[field];
      if (!entry || entry.value == null) continue;
      if ((entry.confidence ?? 0) < threshold) {
        log.debug({ provider: provider.name, field, confidence: entry.confidence }, 'below threshold — skipping');
        continue;
      }
      merged[field] = {
        value: entry.value,
        source: entry.source ?? provider.name,
        confidence: entry.confidence,
        fetched_at: entry.fetched_at ?? new Date().toISOString(),
      };
    }
  }

  return { fields: merged };
}

/**
 * Merge enriched fields into an existing entity patch.
 *
 * Returns a plain patch object suitable for UPDATE. Does NOT touch fields
 * that already have a value in `entity` unless `overwrite` is true.
 *
 * @param {object} entity       - Existing record (to check for blanks)
 * @param {object} enrichResult - Output of runWaterfall
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=false]
 * @returns {{ patch: object, provenance: object[] }}
 */
export function mergeEnrichment(entity, enrichResult, opts = {}) {
  const overwrite = opts.overwrite ?? false;
  const patch = {};
  const provenance = [];

  for (const [field, entry] of Object.entries(enrichResult.fields)) {
    const existing = entity[field];
    if (existing != null && existing !== '' && !overwrite) continue;

    patch[field] = entry.value;
    provenance.push({
      entity_id: entity.id,
      field_name: field,
      field_value: String(entry.value),
      source: entry.source,
      confidence: entry.confidence,
      fetched_at: entry.fetched_at,
      basis: 'legitimate_interests', // GDPR Art. 6(1)(f) / CCPA §1798.100
    });
  }

  return { patch, provenance };
}
