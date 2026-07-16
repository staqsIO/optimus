/**
 * lib/enrichment — pluggable contact/org enrichment layer (OPT-71)
 *
 * Public API:
 *
 *   import { createContactEnricher } from 'lib/enrichment/index.js';
 *
 *   const enricher = createContactEnricher({ query });
 *   const result   = await enricher.enrich(contact, { fields: ['title','phone','company'] });
 *   // result.fields: { [field]: { value, source, confidence, fetched_at } }
 *   // result.patch:  plain object for UPDATE
 *   // result.provenance: array for INSERT into signal.contact_enrichment_provenance
 */

export { runWaterfall, mergeEnrichment, DEFAULT_CONFIDENCE_THRESHOLD } from './provider.js';
export { createEmailSignatureProvider, buildDbFetchSnippets, PROVIDER_NAME as EMAIL_SIG_PROVIDER } from './email-signature-parser.js';
export { createPdlProvider, PROVIDER_NAME as PDL_PROVIDER } from './pdl-provider.js';

import { runWaterfall, mergeEnrichment } from './provider.js';
import { createEmailSignatureProvider, buildDbFetchSnippets } from './email-signature-parser.js';
import { createPdlProvider } from './pdl-provider.js';

/**
 * Build a ready-to-use contact enricher with the default provider stack.
 *
 * Provider order (cheapest-first):
 *   1. email_signature_parser  — free, first-party, always available
 *   2. pdl                     — external, gated by PDL_API_KEY
 *
 * @param {object} opts
 * @param {Function} opts.query - Parameterised DB query function
 * @param {object}   [opts.pdlOpts] - Passed to createPdlProvider (e.g. { httpPost })
 * @returns {{ enrich: Function }}
 */
export function createContactEnricher({ query, pdlOpts = {} }) {
  const providers = [
    createEmailSignatureProvider(buildDbFetchSnippets(query)),
    createPdlProvider(pdlOpts),
  ];

  return {
    /**
     * Enrich a contact entity.
     *
     * @param {object}   entity  - Contact record (must have .id, .email_address)
     * @param {object}   opts
     * @param {string[]} opts.fields - Fields to enrich
     * @returns {Promise<{ fields, patch, provenance }>}
     */
    async enrich(entity, { fields }) {
      const enrichResult = await runWaterfall(entity, fields, providers);
      const { patch, provenance } = mergeEnrichment(entity, enrichResult);
      return { fields: enrichResult.fields, patch, provenance };
    },
  };
}
