/**
 * Slack Bolt app initialization (Socket Mode for MVP).
 * Socket Mode = no public URL needed. MVP-only; production uses Events API.
 */

let app = null;

/**
 * Get or create the Slack Bolt app instance.
 * @returns {import('@slack/bolt').App}
 */
export function getSlackApp() {
  if (app) return app;

  const token = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!token || !signingSecret || !appToken) {
    throw new Error('Slack requires SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, and SLACK_APP_TOKEN');
  }

  // Dynamic import to avoid requiring @slack/bolt when Slack is not configured
  return null; // Replaced at startup by initSlackApp()
}

let _appPromise = null;

/**
 * Initialize the Slack Bolt app. Must be called before getSlackApp().
 * Uses dynamic import so @slack/bolt is only loaded when Slack is configured.
 * @returns {Promise<import('@slack/bolt').App>}
 */
export async function initSlackApp() {
  if (app) return app;
  if (_appPromise) return _appPromise;

  _appPromise = (async () => {
    const { App } = await import('@slack/bolt');

    app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
      logLevel: 'DEBUG',
    });

    return app;
  })();

  app = await _appPromise;
  return app;
}

/**
 * Send a message to a Slack channel or user.
 * @param {string} channelOrUserId - Slack channel ID or user ID
 * @param {string} text - Message text
 * @param {string} [threadTs] - Thread timestamp for reply threading
 * @returns {Promise<{ok: boolean, ts: string}>}
 */
export async function sendMessage(channelOrUserId, text, threadTs = null) {
  if (!app) throw new Error('Slack app not initialized. Call initSlackApp() first.');

  const params = {
    channel: channelOrUserId,
    text,
  };
  if (threadTs) params.thread_ts = threadTs;

  const result = await app.client.chat.postMessage(params);
  return { ok: result.ok, ts: result.ts };
}

/**
 * Look up a Slack user's display name.
 * @param {string} userId - Slack user ID
 * @returns {Promise<{name: string, realName: string, email: string|null}>}
 */
export async function getUserInfo(userId) {
  if (!app) throw new Error('Slack app not initialized');

  const result = await app.client.users.info({ user: userId });
  const user = result.user;
  return {
    name: user.profile?.display_name || user.name || userId,
    realName: user.profile?.real_name || user.name || userId,
    email: user.profile?.email || null,
  };
}

/**
 * Start the Slack Bolt app (Socket Mode connection).
 */
export async function startSlack() {
  if (!app) await initSlackApp();
  await app.start();
  console.log('[slack] Bolt app started (Socket Mode)');
}

/**
 * Stop the Slack Bolt app.
 */
export async function stopSlack() {
  if (app) {
    await app.stop();
    console.log('[slack] Bolt app stopped');
  }
}
