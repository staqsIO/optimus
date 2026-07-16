/**
 * Google Drive auth via Service Account with domain-wide delegation.
 *
 * Used for Drive ingestion when OAuth tokens lack drive.readonly scope
 * (restricted scope requires app verification).
 *
 * Env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key contents (stringified)
 *   GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to JSON key file (fallback)
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';

let cachedAuth = null;

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

/**
 * Build a JWT auth client for the service account.
 *
 * If `userEmail` is provided, impersonates that workspace user via
 * domain-wide delegation (used for regular folders shared with that user).
 * If omitted, the SA authenticates as itself — required for Shared Drives
 * where the SA is added directly as a member (no impersonation needed).
 *
 * @param {string|null|undefined} userEmail - Workspace email to impersonate, or nullish for SA-direct
 * @param {string[]} [scopes] - Override scope list
 */
function buildAuth(userEmail, scopes = DEFAULT_SCOPES) {
  const key = loadServiceAccountKey();
  if (!key) {
    throw new Error('No service account key configured (GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_PATH)');
  }
  const opts = {
    email: key.client_email,
    key: key.private_key,
    scopes,
  };
  if (userEmail) opts.subject = userEmail;
  return new google.auth.JWT(opts);
}

/**
 * Get a Drive-authorized client using the service account.
 *
 * @param {string|null} [userEmail] - Email to impersonate; omit for SA-direct (Shared Drive member)
 * @returns {import('googleapis').drive_v3.Drive}
 */
export function getDriveClient(userEmail) {
  return google.drive({ version: 'v3', auth: buildAuth(userEmail) });
}

/**
 * Get a Docs-authorized client using the service account.
 * Used for `documents.get({ includeTabsContent: true })` on Gemini meeting
 * docs that have multiple tabs (Notes + Transcript) — Drive's plain-text
 * Export API only returns tab 1, so we use the Docs API instead.
 *
 * @param {string|null} [userEmail] - Email to impersonate; omit for SA-direct
 * @returns {import('googleapis').docs_v1.Docs}
 */
export function getDocsClient(userEmail) {
  return google.docs({ version: 'v1', auth: buildAuth(userEmail) });
}

/**
 * STAQPRO-327 — Get a Calendar-authorized client using the service account.
 * `userEmail` is required (Calendar always reads a specific user's calendar
 * via domain-wide delegation; there's no SA-direct equivalent for primary
 * calendars).
 *
 * Scope is `calendar.readonly` — read-only this round. Write access
 * (`calendar.events`) is deferred per Eric's scope decision (would trigger
 * G2 Legal / G5 Reversibility gate work).
 *
 * @param {string} userEmail - Workspace email whose calendar to read (e.g. 'eric@staqs.io')
 * @returns {import('googleapis').calendar_v3.Calendar}
 */
export function getCalendarClient(userEmail) {
  if (!userEmail) {
    throw new Error('getCalendarClient requires a userEmail (no SA-direct mode for Calendar)');
  }
  return google.calendar({
    version: 'v3',
    auth: buildAuth(userEmail, ['https://www.googleapis.com/auth/calendar.readonly']),
  });
}

/**
 * Check if service account auth is available.
 */
export function hasServiceAccount() {
  try {
    return !!loadServiceAccountKey();
  } catch {
    return false;
  }
}

function loadServiceAccountKey() {
  if (cachedAuth) return cachedAuth;

  // Try env var first (JSON string)
  const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (envKey) {
    try {
      cachedAuth = JSON.parse(envKey);
      return cachedAuth;
    } catch (err) {
      console.error('[drive-sa] Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:', err.message);
    }
  }

  // Try file path
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath) {
    try {
      cachedAuth = JSON.parse(readFileSync(keyPath, 'utf8'));
      return cachedAuth;
    } catch (err) {
      console.error(`[drive-sa] Failed to read ${keyPath}:`, err.message);
    }
  }

  return null;
}
