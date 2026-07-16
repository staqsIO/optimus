/**
 * Board authentication routes — GitHub OAuth + token management.
 *
 * NemoClaw and external clients authenticate via GitHub OAuth,
 * which issues a board member JWT (24h TTL, separate keypair).
 *
 * Direct token issuance via API_SECRET is available for dev/CLI.
 */

import { query } from '../db.js';
import { issueBoardToken, revokeBoardToken } from '../runtime/board-jwt.js';

const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

/**
 * Look up board member by GitHub username.
 * @returns {{ id: string, name: string, github_username: string } | null}
 */
async function findBoardMember(githubUsername) {
  const result = await query(
    'SELECT id, display_name, github_username FROM agent_graph.board_members WHERE github_username = $1',
    [githubUsername]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, name: row.display_name, github_username: row.github_username };
}

export function registerBoardAuthRoutes(routes) {
  const clientId = process.env.GITHUB_ID;
  const clientSecret = process.env.GITHUB_SECRET;

  // GET /api/auth/github — redirect to GitHub OAuth
  routes.set('GET /api/auth/github', async (req) => {
    if (!clientId) {
      throw Object.assign(new Error('GitHub OAuth not configured (GITHUB_ID missing)'), { statusCode: 500 });
    }

    // Build the callback URL from the request origin
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:3001';
    const callbackUrl = `${proto}://${host}/api/auth/github/callback`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'read:user read:org',
    });

    return {
      _redirect: `${GITHUB_OAUTH_URL}?${params.toString()}`,
    };
  });

  // GET /api/auth/github/callback — exchange code for token
  routes.set('GET /api/auth/github/callback', async (req) => {
    if (!clientId || !clientSecret) {
      throw Object.assign(new Error('GitHub OAuth not configured'), { statusCode: 500 });
    }

    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    if (!code) {
      throw Object.assign(new Error('Missing OAuth code'), { statusCode: 400 });
    }

    // Exchange code for GitHub access token
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw Object.assign(new Error('GitHub OAuth token exchange failed'), { statusCode: 401 });
    }

    // Get GitHub user info
    const userRes = await fetch(GITHUB_USER_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const user = await userRes.json();
    if (!user.login) {
      throw Object.assign(new Error('Failed to get GitHub user info'), { statusCode: 401 });
    }

    // Verify user is a board member
    const member = await findBoardMember(user.login);
    if (!member) {
      throw Object.assign(new Error(`GitHub user "${user.login}" is not a board member`), { statusCode: 403 });
    }

    // Issue board JWT
    const { token, expiresAt, jti } = issueBoardToken(member.id, member.github_username);

    return {
      token,
      expiresAt,
      jti,
      member: { id: member.id, name: member.name, github_username: member.github_username },
    };
  });

  // POST /api/auth/token — direct token issuance (API_SECRET auth, for dev/CLI)
  routes.set('POST /api/auth/token', async (req, body) => {
    // This route requires API_SECRET (checked by the main auth handler)
    const { github_username } = body;
    if (!github_username) {
      throw Object.assign(new Error('github_username is required'), { statusCode: 400 });
    }

    const member = await findBoardMember(github_username);
    if (!member) {
      throw Object.assign(new Error(`Board member not found: ${github_username}`), { statusCode: 404 });
    }

    // Linus: scope '*' must not be caller-specifiable. Whitelist only.
    const ALLOWED_SCOPES = [
      'work_items:create', 'work_items:read',
      'proposals:approve', 'proposals:reject', 'proposals:read',
      'pipeline:read', 'pipeline:halt',
      'runner:control',
    ];
    const scope = body.scope
      ? body.scope.filter(s => ALLOWED_SCOPES.includes(s))
      : ALLOWED_SCOPES;
    if (scope.length === 0) {
      throw Object.assign(new Error('No valid scopes requested'), { statusCode: 400 });
    }

    // Optional custom token lifetime — only available on this API_SECRET-gated
    // route (the OAuth login path always uses the 24h default). issueBoardToken
    // clamps to [60s, 90d], so an out-of-range request is bounded server-side,
    // never trusted from the body. Omitted/invalid → 24h default.
    let ttlSeconds;
    if (body.expires_in_days !== undefined) {
      const days = Number(body.expires_in_days);
      if (!Number.isFinite(days) || days <= 0) {
        throw Object.assign(new Error('expires_in_days must be a positive number'), { statusCode: 400 });
      }
      ttlSeconds = Math.floor(days * 24 * 60 * 60);
    }
    const { token, expiresAt, jti } = issueBoardToken(member.id, member.github_username, scope, ttlSeconds);

    return {
      token,
      expiresAt,
      jti,
      member: { id: member.id, name: member.name, github_username: member.github_username },
    };
  });

  // POST /api/auth/revoke — revoke a token by jti
  routes.set('POST /api/auth/revoke', async (req, body) => {
    const { jti } = body;
    if (!jti) {
      throw Object.assign(new Error('jti is required'), { statusCode: 400 });
    }

    const memberId = req.auth?.sub || null;
    await revokeBoardToken(jti, memberId, body.reason || 'manual revocation');

    return { revoked: true, jti };
  });
}
