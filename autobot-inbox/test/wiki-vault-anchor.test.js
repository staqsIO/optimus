import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  preferVaultAnchor,
  _clusterSourceFingerprintForTest as clusterFingerprint,
} from '../../lib/wiki/compiler.js';

/**
 * STAQPRO-315 regression — wiki compiler must anchor cluster on vault doc.
 *
 * Background: compileCluster writes `wiki_pages.source_document_id =
 * orderedSourceRows[0].id`. The greedy clusterer picks the most-connected doc
 * as anchor, which is almost always an email summary or TLDv transcript
 * because vault notes embed independently. Without a vault-first preference,
 * curated knowledge becomes invisible to provenance queries.
 *
 * These tests pin the comparator and the no-recompile-loop invariant.
 */
describe('preferVaultAnchor (STAQPRO-315)', () => {
  const vault1 = { id: 'd-vault-1', source: 'vault', raw_text: 'curated note' };
  const vault2 = { id: 'd-vault-2', source: 'vault', raw_text: 'second note' };
  const email1 = { id: 'd-email-1', source: 'email', raw_text: 'email body 1' };
  const email2 = { id: 'd-email-2', source: 'email', raw_text: 'email body 2' };
  const tldv1 = { id: 'd-tldv-1',  source: 'tldv',  raw_text: 'tldv transcript' };

  it('moves vault doc to position 0 when input is email-anchored', () => {
    const rows = [email1, vault1, email2];
    preferVaultAnchor(rows);
    assert.equal(rows[0].id, 'd-vault-1');
    // anchor change is the only ordering guarantee we make; the rest is stable
    assert.deepEqual(rows.slice(1).map((r) => r.id).sort(), ['d-email-1', 'd-email-2']);
  });

  it('preserves order when input is already vault-anchored', () => {
    const rows = [vault1, email1, email2];
    const before = rows.map((r) => r.id);
    preferVaultAnchor(rows);
    assert.deepEqual(rows.map((r) => r.id), before);
  });

  it('preserves order when no vault docs present', () => {
    const rows = [email1, tldv1, email2];
    const before = rows.map((r) => r.id);
    preferVaultAnchor(rows);
    assert.deepEqual(rows.map((r) => r.id), before);
  });

  it('stable: multiple vault docs retain their relative input order', () => {
    const rows = [email1, vault1, email2, vault2];
    preferVaultAnchor(rows);
    assert.deepEqual(rows.map((r) => r.id), ['d-vault-1', 'd-vault-2', 'd-email-1', 'd-email-2']);
  });

  it('handles empty / single-element arrays without mutation', () => {
    const empty = [];
    preferVaultAnchor(empty);
    assert.deepEqual(empty, []);

    const single = [email1];
    preferVaultAnchor(single);
    assert.deepEqual(single.map((r) => r.id), ['d-email-1']);
  });

  // The no-recompile-loop invariant is critical: changing the anchor must NOT
  // change the cluster fingerprint, or compileCluster's skip-when-unchanged
  // path stops working and we burn LLM budget rerunning the same content.
  it('cluster fingerprint is identical before and after reorder', () => {
    const before = [email1, vault1, email2];
    const after = [...before];
    preferVaultAnchor(after);

    const fpBefore = clusterFingerprint(before);
    const fpAfter = clusterFingerprint(after);
    assert.equal(
      fpBefore,
      fpAfter,
      'order-independent fingerprint must survive the anchor reorder'
    );
  });

  it('cluster fingerprint is identical for any permutation of the same source set', () => {
    const a = [email1, vault1, email2];
    const b = [vault1, email2, email1];
    const c = [email2, email1, vault1];
    const fp = clusterFingerprint(a);
    assert.equal(clusterFingerprint(b), fp);
    assert.equal(clusterFingerprint(c), fp);
  });
});
