import 'dotenv/config';
import { createServer } from 'http';
import { ConfidentialClientApplication } from '@azure/msal-node';

/**
 * One-time Outlook OAuth setup.
 * Opens a local HTTP server, prints an auth URL, and exchanges the code
 * for tokens. Paste the refresh token into .env as OUTLOOK_REFRESH_TOKEN.
 *
 * Usage: node scripts/setup-outlook.js
 *
 * Prerequisites:
 *   1. Create an Azure AD app at https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps
 *   2. Under "Authentication", add http://localhost:3457/callback as a redirect URI (Web)
 *   3. Under "Certificates & secrets", create a client secret
 *   4. Under "API permissions", add Microsoft Graph: Mail.Read, Mail.ReadWrite, Mail.Send
 *   5. Set OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_TENANT_ID in .env
 */

const PORT = 3457;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'offline_access'];

async function main() {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const tenantId = process.env.OUTLOOK_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    console.error('Missing OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, or OUTLOOK_TENANT_ID in .env');
    console.error('');
    console.error('Steps:');
    console.error('  1. Go to https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps');
    console.error('  2. Create or select an app registration');
    console.error(`  3. Add ${REDIRECT_URI} as a redirect URI (Web platform)`);
    console.error('  4. Create a client secret under "Certificates & secrets"');
    console.error('  5. Add Mail.Read, Mail.ReadWrite, Mail.Send under API permissions');
    console.error('  6. Copy Client ID, Client Secret, and Tenant ID into .env');
    process.exit(1);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    response_mode: 'query',
    prompt: 'consent',
  });

  const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`;

  console.log('AutoBot Inbox — Outlook OAuth Setup');
  console.log('====================================\n');
  console.log('Open this URL in your browser:\n');
  console.log(`  ${authUrl}\n`);
  console.log(`Waiting for callback on http://localhost:${PORT}...\n`);

  // Start local server to receive the OAuth callback
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      const description = url.searchParams.get('error_description') || error;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Auth failed</h1><p>${description}</p>`);
      console.error(`Auth failed: ${description}`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Missing auth code</h1>');
      return;
    }

    try {
      const msalConfig = {
        auth: {
          clientId,
          clientSecret,
          authority: `https://login.microsoftonline.com/${tenantId}`,
        },
      };

      const msalClient = new ConfidentialClientApplication(msalConfig);

      // Exchange code for tokens
      const tokenResponse = await msalClient.acquireTokenByCode({
        code,
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
      });

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>You can close this tab. Check your terminal.</p>');

      console.log('OAuth tokens received!\n');
      console.log(`Authenticated as: ${tokenResponse.account?.username || 'unknown'}\n`);
      console.log('Add these to your .env file:\n');

      // MSAL doesn't directly expose the refresh token in acquireTokenByCode.
      // The token cache contains it. Extract from the serialized cache.
      const cacheStr = msalClient.getTokenCache().serialize();
      const cache = JSON.parse(cacheStr);
      const refreshTokens = cache.RefreshToken || {};
      const firstRefreshToken = Object.values(refreshTokens)[0];

      if (firstRefreshToken?.secret) {
        console.log(`OUTLOOK_REFRESH_TOKEN=${firstRefreshToken.secret}\n`);
      } else {
        console.log('Warning: Could not extract refresh token from MSAL cache.');
        console.log('You may need to configure the app for offline_access scope.\n');
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
      console.error('Token exchange failed:', err.message);
    }

    server.close();
  });

  server.listen(PORT);
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
