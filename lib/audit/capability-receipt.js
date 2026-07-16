/**
 * STAQPRO-356 / ADR-007 §4: capability receipt envelope.
 *
 * A capability receipt is a signed, verifiable record that an agent in one
 * org exercised a capability against another org's substrate. Today (single-
 * org Phase 1) no real receipts are issued. This module locks the envelope
 * format + signing primitives so when the first federation peer connects,
 * receipts are forward-compatible.
 *
 * Envelope shape (receipt_version=1):
 *   {
 *     receipt_version:       "1",
 *     origin_org:            "<org-id>",
 *     grant_id:              "<uuid>",
 *     agent_sub:             "agent:<id>",
 *     agent_tier:            "executor|reviewer|orchestrator|...",
 *     action:                "rag_query|graph_read|...",
 *     document_ids:          ["<uuid>", ...],
 *     classification_ceiling: <0|1|2|3>,
 *     issued_at:             "<ISO8601>",
 *     transition_hash:       "sha256:<hex>",
 *     signature:             "ed25519:<base64>"   // added by signReceipt()
 *   }
 *
 * Canonicalization is RFC 8785 JCS: sorted keys + minimal JSON for
 * deterministic signatures across implementations. This module is
 * intentionally tiny — no I/O, no DB, no Neo4j. Same signing utility can be
 * exposed by an external optimus-verify CLI later.
 *
 * Key source priority:
 *   1. CAPABILITY_RECEIPT_KEY_PEM env (production)
 *   2. Ephemeral ed25519 keypair (dev/test) — logged once.
 *
 * Out of scope (deferred per ticket): remote JWKS resolution; federation
 * transport; revocation; full delegation chain (RFC 8693).
 */

import {
  createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as cryptoSign, verify as cryptoVerify,
} from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('audit/capability-receipt');

let _privateKey = null;
let _publicKey = null;
let _ephemeralWarned = false;

function initKeys() {
  if (_privateKey && _publicKey) return;
  const pem = process.env.CAPABILITY_RECEIPT_KEY_PEM;
  if (pem) {
    _privateKey = createPrivateKey(pem);
    _publicKey = createPublicKey(_privateKey);
    if (_privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`CAPABILITY_RECEIPT_KEY_PEM must be an ed25519 key (got ${_privateKey.asymmetricKeyType})`);
    }
    log.info('Capability-receipt keys loaded from CAPABILITY_RECEIPT_KEY_PEM');
    return;
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  _privateKey = privateKey;
  _publicKey = publicKey;
  if (!_ephemeralWarned) {
    log.warn('CAPABILITY_RECEIPT_KEY_PEM unset — using ephemeral ed25519 keypair. Set the env var before issuing receipts to federation peers.');
    _ephemeralWarned = true;
  }
}

/**
 * RFC 8785 JCS — canonical JSON: sorted keys recursively, no whitespace.
 * Same input → same output across implementations, so signatures are
 * verifiable by any conformant signer/verifier.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

const REQUIRED_FIELDS = [
  'receipt_version', 'origin_org', 'grant_id', 'agent_sub',
  'agent_tier', 'action', 'issued_at', 'transition_hash',
];

function assertEnvelope(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('Receipt must be an object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof receipt[field] !== 'string' || receipt[field].length === 0) {
      throw new Error(`Receipt missing required string field: ${field}`);
    }
  }
  if (receipt.receipt_version !== '1') {
    throw new Error(`Unsupported receipt_version: ${receipt.receipt_version} (expected "1")`);
  }
  if (!receipt.transition_hash.startsWith('sha256:')) {
    throw new Error('transition_hash must start with "sha256:"');
  }
  if (receipt.document_ids != null && !Array.isArray(receipt.document_ids)) {
    throw new Error('document_ids must be an array if present');
  }
  if (receipt.classification_ceiling != null) {
    const c = receipt.classification_ceiling;
    if (!Number.isInteger(c) || c < 0 || c > 3) {
      throw new Error('classification_ceiling must be an integer 0..3 if present');
    }
  }
}

/**
 * Sign a receipt envelope. Returns the receipt with a `signature` field
 * appended (`ed25519:<base64>`). Input must not already contain `signature`
 * to keep canonicalization deterministic.
 */
export function signReceipt(receipt) {
  initKeys();
  assertEnvelope(receipt);
  if (receipt.signature != null) {
    throw new Error('signReceipt called on a receipt that already has a signature');
  }
  const canonical = canonicalize(receipt);
  const sig = cryptoSign(null, Buffer.from(canonical, 'utf-8'), _privateKey);
  return { ...receipt, signature: `ed25519:${sig.toString('base64')}` };
}

/**
 * Verify a signed receipt against the local public key. Returns true on
 * success, false on signature mismatch. Throws on malformed envelopes (so
 * caller distinguishes "invalid format" from "valid format, bad signature").
 *
 * For receipts from remote origin_orgs the JWKS lookup is deferred — those
 * throw a structured error with code='REMOTE_ORIGIN_NOT_IMPLEMENTED'.
 */
export function verifyReceipt(receipt) {
  initKeys();
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('Receipt must be an object');
  }
  if (typeof receipt.signature !== 'string' || !receipt.signature.startsWith('ed25519:')) {
    throw new Error('Receipt missing valid ed25519: signature');
  }
  const { signature, ...unsigned } = receipt;
  assertEnvelope(unsigned);

  const localOrg = process.env.OPTIMUS_ORG_ID || 'self';
  if (unsigned.origin_org !== localOrg) {
    const err = new Error(`Remote-origin receipt verification not yet implemented (origin_org=${unsigned.origin_org})`);
    err.code = 'REMOTE_ORIGIN_NOT_IMPLEMENTED';
    err.origin_org = unsigned.origin_org;
    throw err;
  }

  const canonical = canonicalize(unsigned);
  const sigBytes = Buffer.from(signature.slice('ed25519:'.length), 'base64');
  return cryptoVerify(null, Buffer.from(canonical, 'utf-8'), _publicKey, sigBytes);
}

/** Test-only — reset the in-process keypair so tests can re-init under
 *  different env settings. Never call from production code paths. */
export function _resetForTest() {
  _privateKey = null;
  _publicKey = null;
  _ephemeralWarned = false;
}
