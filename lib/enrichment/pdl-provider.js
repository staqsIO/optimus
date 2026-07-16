/**
 * People Data Labs (PDL) — Enrichment Provider 2 (OPT-71)
 *
 * STUB / GATED provider. Documents the contract; does NOT hit a real API.
 *
 * Gate: requires PDL_API_KEY in env. Without it, isAvailable() returns false
 * and the waterfall runner skips this provider entirely. No personal data
 * leaves the system unless the key is explicitly configured.
 *
 * To activate:
 *   1. Set PDL_API_KEY=<your key> in .env
 *   2. Replace the stub enrich() below with the real PDL Person Enrich API call.
 *      Endpoint: POST https://api.peopledatalabs.com/v5/person/enrich
 *      Auth: X-Api-Key header
 *      Docs: https://docs.peopledatalabs.com/docs/person-enrichment-api
 *
 * Cost model: PDL charges per successful match. Only call when:
 *   - isAvailable() is true (key configured)
 *   - The upstream waterfall has not already filled the requested fields
 *     from cheaper/free providers.
 *
 * Basis for processing (GDPR Art. 6 / CCPA): legitimate interests — enriching
 * contact records for Optimus inbox-management. PDL is a B2B data vendor;
 * their data is sourced from public professional profiles. Document this
 * basis in your DPA with PDL before activating. Provenance is recorded
 * per-field so right-to-erasure can be actioned at the field level.
 *
 * Fields this provider can fill (when activated):
 *   title, company, linkedin, twitter, github, location, seniority
 */

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'enrichment/pdl-provider' });

export const PROVIDER_NAME = 'pdl';

/**
 * Create the PDL enrichment provider.
 *
 * @param {object} [opts]
 * @param {Function} [opts.httpPost] - Injected HTTP function for testing.
 *   Signature: async (url, body, headers) => { status, data }
 *   When not provided the real provider is STUB-only and returns empty fields.
 * @returns {EnrichmentProvider}
 */
export function createPdlProvider(opts = {}) {
  const { httpPost } = opts;

  return {
    name: PROVIDER_NAME,

    /**
     * Returns true only when PDL_API_KEY is configured.
     * Without the key this provider is completely inert — the waterfall
     * skips it and no external call is ever made.
     */
    isAvailable() {
      const available = Boolean(process.env.PDL_API_KEY);
      if (!available) {
        // Logged at trace level only — this is the normal/expected state
        log.debug('PDL_API_KEY not set — PDL provider inert (expected in dev/test)');
      }
      return available;
    },

    /**
     * Enrich an entity using the PDL Person Enrich API.
     *
     * STUB: This implementation is inert. Replace the body of the
     * `if (httpPost)` branch with a real PDL API call when activating.
     *
     * @param {object} entity   - { id, email_address, name?, ... }
     * @param {object} opts     - { fields: string[] }
     * @returns {Promise<EnrichResult>}
     */
    async enrich(entity, { fields }) {
      const apiKey = process.env.PDL_API_KEY;
      if (!apiKey) {
        // Should not be reached (waterfall checks isAvailable first),
        // but fail safely just in case.
        return { fields: {} };
      }

      // ── STUB: Replace below with real PDL call ──────────────────────────
      if (!httpPost) {
        log.warn({ entityId: entity.id }, 'PDL provider: no httpPost injected — returning empty (stub mode)');
        return { fields: {} };
      }

      // Example of the real call (activated only when httpPost is injected):
      //
      // const { status, data } = await httpPost(
      //   'https://api.peopledatalabs.com/v5/person/enrich',
      //   { email: entity.email_address, pretty: false },
      //   { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      // );
      //
      // if (status !== 200 || !data?.data) return { fields: {} };
      //
      // Map PDL response fields to our schema:
      // const person = data.data;
      // const now = new Date().toISOString();
      // const enriched = {};
      // if (fields.includes('title') && person.job_title)
      //   enriched.title = { value: person.job_title, source: PROVIDER_NAME, confidence: 0.90, fetched_at: now };
      // if (fields.includes('company') && person.job_company_name)
      //   enriched.company = { value: person.job_company_name, source: PROVIDER_NAME, confidence: 0.90, fetched_at: now };
      // if (fields.includes('linkedin') && person.linkedin_url)
      //   enriched.linkedin = { value: person.linkedin_url, source: PROVIDER_NAME, confidence: 0.95, fetched_at: now };
      // return { fields: enriched };

      // ── End stub ─────────────────────────────────────────────────────────
      return { fields: {} };
    },
  };
}
