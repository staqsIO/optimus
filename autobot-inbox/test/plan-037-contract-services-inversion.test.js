/**
 * Plan 037 — dependency inversion that unblocks relocating lib/contracts +
 * lib/wiki out of the substrate.
 *
 * Before this plan, two lib/* modules named lib/contracts/* directly:
 *   - lib/engagements/docx-export.js   (static import of brand-profile.js)
 *   - lib/signatures/signer.js         (dynamic import of pdf-render.js +
 *                                       spawn-work-items.js)
 * A naive relocation of contracts/ into autobot-inbox/src/ would rewrite those
 * imports to reach ACROSS the layer boundary, adding a CG-1 violation. The fix
 * inverts the dependency through the existing capability registry: the product
 * registers the renderer / spawn / brand-profile implementations at startup and
 * the lib consumers resolve them via getCapability(). lib/* no longer names
 * lib/contracts/*.
 *
 * These are the characterization + regression guards for that inversion. They
 * are source-level + registry-contract checks on purpose:
 *   - The full render/sign flow cannot be exercised in CI — lib/engagements/
 *     docx-export.js top-level `import 'docx'` resolves to an UNDECLARED
 *     dependency (absent from package.json/node_modules; see
 *     staqpro-531-viewer-scoping.test.js), so importing that module crashes
 *     for reasons unrelated to this change. That breakage is out of scope
 *     (Plan 037 is behaviour-preserving).
 *   - The load-bearing invariant Plan 037 protects is structural: "no lib/-side
 *     file imports a relocated contracts/wiki module." A static guard fails the
 *     moment a future edit re-couples them — exactly the STOP condition the plan
 *     names. That is the money-adjacent safety net here.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  registerCapability,
  getCapability,
  hasCapability,
  clearCapabilities,
} from '../../lib/runtime/capability-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const CONTRACT_KEYS = [
  'contracts/pdf-render',
  'contracts/spawn-work-items',
  'contracts/brand-profile',
];

describe('Plan 037 — contract-services dependency inversion', () => {
  describe('capability-registry contract (producer ↔ consumer wiring)', () => {
    beforeEach(() => clearCapabilities());

    it('round-trips the three contract capability keys with the expected method shapes', () => {
      const renderContractPdf = async () => Buffer.from('pdf');
      const spawnWorkItemsForRequest = async () => ({ claimed: true });
      const loadBrandProfileForEngagement = async () => ({ profile: { slug: 'eng' } });
      const loadDefaultBrandProfile = async () => ({ profile: { slug: 'default' } });

      registerCapability('contracts/pdf-render', { renderContractPdf });
      registerCapability('contracts/spawn-work-items', { spawnWorkItemsForRequest });
      registerCapability('contracts/brand-profile', {
        loadBrandProfileForEngagement,
        loadDefaultBrandProfile,
      });

      // signer.js resolves these two:
      assert.strictEqual(
        getCapability('contracts/pdf-render').renderContractPdf,
        renderContractPdf,
      );
      assert.strictEqual(
        getCapability('contracts/spawn-work-items').spawnWorkItemsForRequest,
        spawnWorkItemsForRequest,
      );
      // docx-export.js resolves these two:
      const brand = getCapability('contracts/brand-profile');
      assert.strictEqual(brand.loadBrandProfileForEngagement, loadBrandProfileForEngagement);
      assert.strictEqual(brand.loadDefaultBrandProfile, loadDefaultBrandProfile);
    });

    it('getCapability throws when a contract capability is unregistered — the graceful-degradation path', () => {
      // signer.js wraps getCapability in the existing try/catch (PDF omitted /
      // spawn logged, both non-fatal); docx-export.js calls it inside
      // safeLoad(), which swallows the throw and falls back to FALLBACK_BRAND.
      // Either way an unregistered capability degrades, it never crashes signing.
      for (const key of CONTRACT_KEYS) {
        assert.strictEqual(hasCapability(key), false);
        assert.throws(() => getCapability(key), /No capability registered/);
      }
    });

    it("docx-export's brand resolver shape falls back to null under safeLoad when unregistered", async () => {
      // Replicates the exact resolver + safeLoad wrapper from
      // lib/engagements/docx-export.js to prove the unregistered path yields
      // null (→ FALLBACK_BRAND) rather than throwing out of the render.
      const loadDefaultBrandProfile = () =>
        getCapability('contracts/brand-profile').loadDefaultBrandProfile();
      const safeLoad = async (fn) => {
        try {
          return await fn();
        } catch {
          return null;
        }
      };

      assert.strictEqual(await safeLoad(loadDefaultBrandProfile), null); // unregistered → null

      registerCapability('contracts/brand-profile', {
        loadDefaultBrandProfile: async () => ({ profile: { slug: 'default' } }),
        loadBrandProfileForEngagement: async () => null,
      });
      const loaded = await safeLoad(loadDefaultBrandProfile);
      assert.deepStrictEqual(loaded, { profile: { slug: 'default' } }); // registered → real value
    });
  });

  describe('static invariant — lib/* no longer names lib/contracts/*', () => {
    it('lib/signatures/signer.js resolves render + spawn via the capability registry', () => {
      const src = read('lib/signatures/signer.js');
      assert.doesNotMatch(
        src,
        /from\s+['"][^'"]*\/contracts\//,
        'signer.js must not statically import lib/contracts/*',
      );
      assert.doesNotMatch(
        src,
        /import\(\s*['"][^'"]*\/contracts\//,
        'signer.js must not dynamic-import lib/contracts/*',
      );
      assert.match(src, /getCapability\(\s*['"]contracts\/pdf-render['"]\s*\)/);
      assert.match(src, /getCapability\(\s*['"]contracts\/spawn-work-items['"]\s*\)/);
    });

    it('lib/engagements/docx-export.js resolves brand profiles via the capability registry', () => {
      const src = read('lib/engagements/docx-export.js');
      assert.doesNotMatch(
        src,
        /from\s+['"][^'"]*\/contracts\//,
        'docx-export.js must not statically import lib/contracts/*',
      );
      assert.doesNotMatch(
        src,
        /import\(\s*['"][^'"]*\/contracts\//,
        'docx-export.js must not dynamic-import lib/contracts/*',
      );
      assert.match(src, /getCapability\(\s*['"]contracts\/brand-profile['"]\s*\)/);
    });
  });

  describe('startup registration — the callbacks are populated before any render/sign', () => {
    it('autobot-inbox/src/index.js registers all three contract capabilities', () => {
      const src = read('autobot-inbox/src/index.js');
      for (const key of CONTRACT_KEYS) {
        assert.match(
          src,
          new RegExp(`registerCapability\\(\\s*['"]${key.replace('/', '\\/')}['"]`),
          `index.js must registerCapability('${key}')`,
        );
      }
    });
  });
});
