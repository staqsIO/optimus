/**
 * Tests the unenrolled_speakers API and the atomic promote-to-voice_prints
 * flow. The resolver's WavLM capture path needs the transformers model
 * loaded which is too heavy for a unit test, so this exercises the DB
 * surface and the route handlers directly.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { registerVoicePrintsRoutes } from '../src/api-routes/voice-prints.js';

let query;
const routes = new Map();
registerVoicePrintsRoutes(routes);

before(async () => {
  ({ query } = await getDb());
});

beforeEach(async () => {
  await query(`DELETE FROM voice.unenrolled_speakers`).catch(() => {});
  await query(`DELETE FROM voice.voice_prints`).catch(() => {});
  await query(`DELETE FROM signal.contacts WHERE email_address LIKE 'test+%@example.com'`).catch(() => {});
});

// Helper: build a deterministic 512-dim vector literal.
function mkVector(seed) {
  const v = new Array(512).fill(0).map((_, i) => Math.sin(seed * 0.01 + i * 0.001));
  // L2 normalize
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
  return `[${v.map((x) => (x / n).toFixed(7)).join(',')}]`;
}

async function seedCandidate(label, occurrences = 1) {
  const r = await query(
    `INSERT INTO voice.unenrolled_speakers
        (embedding, candidate_label, sample_utterance, occurrence_count)
     VALUES ($1::vector, $2, $3, $4)
     RETURNING id`,
    [mkVector(label.charCodeAt(0)), label, `Sample from ${label}`, occurrences],
  );
  return r.rows[0].id;
}

async function seedContact(email) {
  const r = await query(
    `INSERT INTO signal.contacts (email_address, name, tier)
     VALUES ($1, 'Test Person', 'active')
     ON CONFLICT (email_address) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email],
  );
  return r.rows[0].id;
}

function fakeReq(url) {
  return { url };
}

describe('GET /api/voice-prints/unenrolled', () => {
  it('returns rows ordered by occurrence_count DESC', async () => {
    await seedCandidate('A', 3);
    await seedCandidate('B', 12);
    await seedCandidate('C', 1);

    const handler = routes.get('GET /api/voice-prints/unenrolled');
    const result = await handler(fakeReq('/api/voice-prints/unenrolled'));

    assert.equal(result.candidates.length, 3);
    assert.equal(result.candidates[0].candidate_label, 'B');
    assert.equal(result.candidates[0].occurrence_count, 12);
    assert.equal(result.candidates[1].candidate_label, 'A');
    assert.equal(result.candidates[2].candidate_label, 'C');
  });

  it('returns empty list when no candidates exist', async () => {
    const handler = routes.get('GET /api/voice-prints/unenrolled');
    const result = await handler(fakeReq('/api/voice-prints/unenrolled'));
    assert.equal(result.candidates.length, 0);
  });
});

describe('POST /api/voice-prints/unenrolled/:id/approve', () => {
  it('atomically promotes candidate to voice_prints + deletes unenrolled row', async () => {
    const candidateId = await seedCandidate('A', 5);
    const contactId = await seedContact('test+approve@example.com');

    const handler = routes.get('POST /api/voice-prints/unenrolled/:id/approve');
    const result = await handler(
      fakeReq(`/api/voice-prints/unenrolled/${candidateId}/approve`),
      { contact_id: contactId, display_name: 'Test Person' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.voicePrint.contact_id, contactId);
    assert.equal(result.voicePrint.display_name, 'Test Person');

    // Candidate row should be gone.
    const remaining = await query(
      `SELECT id FROM voice.unenrolled_speakers WHERE id = $1`,
      [candidateId],
    );
    assert.equal(remaining.rows.length, 0);

    // voice_prints should have the new row.
    const newPrint = await query(
      `SELECT contact_id, display_name FROM voice.voice_prints WHERE contact_id = $1`,
      [contactId],
    );
    assert.equal(newPrint.rows.length, 1);
    assert.equal(newPrint.rows[0].display_name, 'Test Person');
  });

  it('rejects when contact_id missing', async () => {
    const candidateId = await seedCandidate('A');
    const handler = routes.get('POST /api/voice-prints/unenrolled/:id/approve');

    let err;
    try {
      await handler(
        fakeReq(`/api/voice-prints/unenrolled/${candidateId}/approve`),
        { display_name: 'No Contact' },
      );
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it('returns 404 for unknown candidate id', async () => {
    const contactId = await seedContact('test+404@example.com');
    const handler = routes.get('POST /api/voice-prints/unenrolled/:id/approve');

    let err;
    try {
      await handler(
        fakeReq('/api/voice-prints/unenrolled/nonexistent-id/approve'),
        { contact_id: contactId, display_name: 'Ghost' },
      );
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });
});

describe('DELETE /api/voice-prints/unenrolled/:id', () => {
  it('dismisses a candidate without enrolling', async () => {
    const candidateId = await seedCandidate('A');
    const handler = routes.get('DELETE /api/voice-prints/unenrolled/:id');

    const result = await handler(fakeReq(`/api/voice-prints/unenrolled/${candidateId}`));
    assert.equal(result.ok, true);

    const remaining = await query(
      `SELECT id FROM voice.unenrolled_speakers WHERE id = $1`,
      [candidateId],
    );
    assert.equal(remaining.rows.length, 0);
  });
});
