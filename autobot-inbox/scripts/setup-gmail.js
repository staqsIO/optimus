import 'dotenv/config';
import { createServer } from 'http';
import { google } from 'googleapis';

/**
 * One-time Gmail OAuth setup.
 * Opens a local HTTP server, prints an auth URL, and exchanges the code
 * for a refresh token. Paste the token into .env as GMAIL_REFRESH_TOKEN.
 *
 * Usage: node scripts/setup-gmail.js
 *
 * Prerequisites:
 *   1. Create a Google Cloud project at https://console.cloud.google.com
 *   2. Enable the Gmail API
 *   3. Create OAuth 2.0 credentials (type: Web application)
 *      - Add http://localhost:3456/callback as an authorized redirect URI
 *   4. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env
 */

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
];

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env');
    console.error('');
    console.error('Steps:');
    console.error('  1. Go to https://console.cloud.google.com/apis/credentials');
    console.error('  2. Create OAuth 2.0 Client ID (type: Web application)');
    console.error(`  3. Add ${REDIRECT_URI} as an authorized redirect URI`);
    console.error('  4. Copy Client ID and Client Secret into .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('AutoBot Inbox — Gmail OAuth Setup');
  console.log('==================================\n');
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Auth failed</h1><p>${error}</p>`);
      console.error(`Auth failed: ${error}`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Missing auth code</h1>');
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>You can close this tab. Check your terminal.</p>');

      console.log('OAuth tokens received!\n');
      console.log('Add this to your .env file:\n');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);

      if (tokens.access_token) {
        // Quick verification
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        console.log(`Verified: connected to ${profile.data.emailAddress}`);
        console.log(`Total messages: ${profile.data.messagesTotal}\n`);
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
