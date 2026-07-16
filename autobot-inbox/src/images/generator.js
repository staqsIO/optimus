/**
 * NB2 Image Generator — Gemini Flash image generation for content pipeline.
 * Same pattern as redesign-imagegen.js, adapted for blog header images.
 *
 * Uses Gemini 2.0 Flash Preview with image generation modality.
 * Cost: ~$0.04/image. Gracefully degrades if GEMINI_API_KEY not set.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createChildLogger } from '../../../lib/logger.js';

const log = createChildLogger({ module: 'nb2-imagegen' });

const MODEL_NAME = 'gemini-2.5-flash-image';
const COST_PER_IMAGE_USD = 0.04;

// UMB Advisors brand palette for consistent visual identity
const UMB_STYLE = {
  background: '#0A0A0A',
  accent: '#C9A96E',
  style: 'dark, minimal, professional advisory firm aesthetic',
  negatives: 'text, watermarks, AI-generated look, stock photo aesthetic, plastic skin, distorted faces, logos, busy backgrounds',
};

/**
 * NB2 prompt template for advisory/professional content.
 * Maps topic + style to a structured image generation prompt.
 *
 * @param {string} prompt - Base prompt from executor-writer Phase 4
 * @param {Object} [opts] - Style overrides
 * @returns {string} Structured NB2 prompt
 */
function buildNB2Prompt(prompt, opts = {}) {
  const style = opts.style || UMB_STYLE.style;
  const accent = opts.accent || UMB_STYLE.accent;
  const bg = opts.background || UMB_STYLE.background;

  return [
    `[SUBJECT] ${prompt}`,
    `[CAMERA] 50mm lens, eye level, shallow depth of field`,
    `[LIGHTING] Soft directional light, warm amber tones, subtle shadows`,
    `[COLOR] Dark background (${bg}), warm gold accent (${accent}), muted earth tones`,
    `[COMPOSITION] Clean, minimal, plenty of negative space, editorial quality`,
    `[STYLE] ${style}`,
    `[NEGATIVE] --no ${UMB_STYLE.negatives}`,
  ].join(' ');
}

/**
 * Generate an image using Gemini Flash.
 *
 * @param {string} prompt - Image description prompt
 * @param {Object} [opts] - Options
 * @param {string} [opts.style] - Style override
 * @param {string} [opts.accent] - Accent color override
 * @param {string} [opts.background] - Background color override
 * @returns {Promise<{imageBuffer: Buffer, mimeType: string, promptUsed: string, costUsd: number}|null>}
 */
export async function generateImage(prompt, opts = {}) {
  const apiKey = process.env.NANOBANANA_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('NANOBANANA_API_KEY / GEMINI_API_KEY not set — skipping image generation (graceful degradation)');
    return null;
  }

  const nb2Prompt = buildNB2Prompt(prompt, opts);
  log.info({ promptLength: nb2Prompt.length }, 'Generating image via Gemini Flash');

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const result = await model.generateContent(nb2Prompt);
    const response = result.response;

    // Extract image from response parts
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        const mimeType = part.inlineData.mimeType || 'image/png';

        log.info({
          mimeType,
          sizeBytes: imageBuffer.length,
          cost: COST_PER_IMAGE_USD,
        }, 'Image generated successfully');

        return {
          imageBuffer,
          mimeType,
          promptUsed: nb2Prompt,
          costUsd: COST_PER_IMAGE_USD,
        };
      }
    }

    log.warn('Gemini response contained no image data');
    return null;
  } catch (err) {
    log.error({ err: err.message }, 'Gemini image generation failed');
    return null;
  }
}

export { COST_PER_IMAGE_USD, buildNB2Prompt };
