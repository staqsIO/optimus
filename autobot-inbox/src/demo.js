import { readFileSync, existsSync } from 'fs';
import { query } from './db.js';
import { emit } from './runtime/event-bus.js';

/**
 * Demo mode: load synthetic emails from fixtures into the pipeline.
 * Replaces Gmail polling — no external credentials needed.
 *
 * Each email is inserted into inbox.messages, a work item is created
 * in the task graph, and a task_assigned event is emitted to trigger
 * the triage agent. The full pipeline runs exactly as with real Gmail.
 */

const fixturesPath = new URL('../fixtures/demo-emails.json', import.meta.url);
const fixtures = existsSync(fixturesPath)
  ? JSON.parse(readFileSync(fixturesPath, 'utf-8'))
  : [];

export async function loadDemoEmails() {
  console.log(`[demo] Loading ${fixtures.length} demo emails...`);

  // Create VIP contacts first
  const vipEmails = fixtures.filter(e => e.is_vip);
  for (const email of vipEmails) {
    await query(
      `INSERT INTO signal.contacts (email_address, name, is_vip, vip_reason, contact_type, emails_received)
       VALUES ($1, $2, true, 'Demo VIP', 'partner', 1)
       ON CONFLICT (email_address) DO UPDATE SET is_vip = true`,
      [email.from_address, email.from_name]
    );
  }

  let loaded = 0;
  for (const email of fixtures) {
    // Slack entries are handled by loadDemoSlackMessages()
    if (email.channel === 'slack') continue;

    // Check if already loaded (idempotent)
    const existing = await query(
      `SELECT id FROM inbox.messages WHERE provider_msg_id = $1`,
      [email.provider_msg_id]
    );
    if (existing.rows.length > 0) continue;

    // Insert email metadata
    const emailResult = await query(
      `INSERT INTO inbox.messages
       (provider_msg_id, thread_id, message_id, from_address, from_name,
        to_addresses, subject, snippet, received_at, labels, has_attachments,
        triage_category, priority_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '${Math.floor(Math.random() * 120)} minutes', $9, $10,
               'pending', null)
       RETURNING id`,
      [
        email.provider_msg_id, email.thread_id, email.message_id,
        email.from_address, email.from_name,
        email.to_addresses, email.subject, email.snippet,
        email.labels, email.has_attachments,
      ]
    );

    const emailId = emailResult.rows[0].id;

    // Create work item in task graph
    const workItemResult = await query(
      `INSERT INTO agent_graph.work_items
       (type, title, description, status, created_by, assigned_to, priority, metadata)
       VALUES ('task', $1, $2, 'assigned', 'orchestrator', 'executor-triage', $3, $4)
       RETURNING id`,
      [
        `Triage: ${email.subject}`,
        `Triage email from ${email.from_name || email.from_address}: ${email.subject}`,
        email.priority || 50,
        JSON.stringify({ email_id: emailId, provider_msg_id: email.provider_msg_id, demo: true }),
      ]
    );

    const workItemId = workItemResult.rows[0].id;

    // Link email to work item
    await query(
      `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
      [workItemId, emailId]
    );

    // Emit task_assigned event to wake up triage agent
    await emit({
      eventType: 'task_assigned',
      workItemId,
      targetAgentId: 'executor-triage',
      priority: email.priority || 50,
      eventData: {
        email_id: emailId,
        subject: email.subject,
        from: email.from_address,
        demo: true,
      },
    });

    loaded++;
  }

  console.log(`[demo] Loaded ${loaded} demo emails (${fixtures.length - loaded} already existed)`);

  // Multi-channel: load Slack demo messages
  const slackLoaded = await loadDemoSlackMessages();
  const totalLoaded = loaded + slackLoaded;

  // Also pre-populate some demo data that would normally come from voice analysis
  await seedDemoVoiceProfile();
  await seedDemoTopics();

  return totalLoaded;
}

async function loadDemoSlackMessages() {
  const slackMessages = [
    {
      from_address: 'dustin@slack',
      from_name: 'Dustin',
      subject: null,
      snippet: 'yo Bennett is in. can we add slack before Monday?',
      channel: 'slack',
      channel_id: 'slack_demo_1',
    },
    {
      from_address: 'maya@slack',
      from_name: 'Maya',
      subject: null,
      snippet: 'compliance docs uploaded to the shared drive. lmk if you need anything else',
      channel: 'slack',
      channel_id: 'slack_demo_2',
    },
  ];

  // Ensure demo Slack account exists (required by messages_non_email_requires_account constraint)
  await query(
    `INSERT INTO inbox.accounts (id, channel, provider, label, identifier, sync_status)
     VALUES ('demo-slack', 'slack', 'slack', 'Demo Slack', 'demo-workspace', 'active')
     ON CONFLICT (channel, provider, identifier) DO NOTHING`
  );

  let loaded = 0;
  for (const msg of slackMessages) {
    // Dedup check via channel + channel_id
    const existing = await query(
      `SELECT id FROM inbox.messages WHERE channel = 'slack' AND channel_id = $1`,
      [msg.channel_id]
    );
    if (existing.rows.length > 0) continue;

    // Insert Slack message metadata
    const msgResult = await query(
      `INSERT INTO inbox.messages
       (provider_msg_id, thread_id, message_id, from_address, from_name,
        to_addresses, subject, snippet, received_at, labels, has_attachments,
        channel, account_id, channel_id,
        triage_category, priority_score)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, now() - interval '${Math.floor(Math.random() * 60)} minutes', $8, false,
               'slack', 'demo-slack', $9,
               'pending', null)
       RETURNING id`,
      [
        'slack-demo-channel',    // thread_id: synthetic Slack channel ID
        msg.channel_id,          // message_id: unique ref
        msg.from_address,        // from_address
        msg.from_name,           // from_name
        [],                      // to_addresses (Slack messages have no explicit recipients)
        msg.subject,             // subject (null for Slack)
        msg.snippet,             // snippet: full message text
        ['SLACK'],               // labels
        msg.channel_id,          // channel_id for dedup
      ]
    );

    const emailId = msgResult.rows[0].id;

    // Create work item in task graph (same pattern as email demos)
    const workItemResult = await query(
      `INSERT INTO agent_graph.work_items
       (type, title, description, status, created_by, assigned_to, priority, metadata)
       VALUES ('task', $1, $2, 'assigned', 'orchestrator', 'executor-triage', $3, $4)
       RETURNING id`,
      [
        `Triage: Slack from ${msg.from_name}`,
        `Triage Slack message from ${msg.from_name}: ${msg.snippet.slice(0, 80)}`,
        50,
        JSON.stringify({ email_id: emailId, channel: 'slack', channel_id: msg.channel_id, demo: true }),
      ]
    );

    const workItemId = workItemResult.rows[0].id;

    // Link message to work item
    await query(
      `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
      [workItemId, emailId]
    );

    // Emit task_assigned event to wake up triage agent
    await emit({
      eventType: 'task_assigned',
      workItemId,
      targetAgentId: 'executor-triage',
      priority: 50,
      eventData: {
        email_id: emailId,
        subject: `Slack: ${msg.from_name}`,
        from: msg.from_address,
        channel: 'slack',
        demo: true,
      },
    });

    loaded++;
  }

  console.log(`[demo] Loaded ${loaded} Slack demo messages (${slackMessages.length - loaded} already existed)`);
  return loaded;
}

async function seedDemoVoiceProfile() {
  const existing = await query(
    `SELECT id FROM voice.profiles WHERE scope = 'global' LIMIT 1`
  );
  if (existing.rows.length > 0) return;

  await query(
    `INSERT INTO voice.profiles
     (scope, scope_key, greetings, closings, vocabulary, tone_markers, avg_length, formality_score, sample_count)
     VALUES ('global', 'default',
       $1, $2, $3, $4, 120, 0.65, 50)`,
    [
      ['Hey', 'Hi', 'Hey there'],
      ['Best', 'Thanks', 'Cheers', '— Eric'],
      JSON.stringify({
        frequent: ['ship', 'build', 'push', 'land', 'solid', 'legit'],
        avoid: ['synergy', 'leverage', 'paradigm', 'circle back'],
      }),
      JSON.stringify({
        formality: 0.65,
        warmth: 0.75,
        directness: 0.85,
        vocabulary: 0.60,
      }),
    ]
  );
  console.log('[demo] Seeded global voice profile');
}

async function seedDemoTopics() {
  const existing = await query(`SELECT id FROM signal.topics LIMIT 1`);
  if (existing.rows.length > 0) return;

  const topics = [
    { name: 'AutoBot', score: 95, direction: 'rising', mentions: 8 },
    { name: 'Fundraising', score: 82, direction: 'rising', mentions: 5 },
    { name: 'Metrc Compliance', score: 60, direction: 'stable', mentions: 3 },
    { name: 'Infrastructure', score: 45, direction: 'stable', mentions: 4 },
    { name: 'YC Application', score: 78, direction: 'rising', mentions: 2 },
  ];

  for (const t of topics) {
    await query(
      `INSERT INTO signal.topics (name, trend_score, trend_direction, mention_count, last_mentioned)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (name) DO NOTHING`,
      [t.name, t.score, t.direction, t.mentions]
    );
  }
  console.log('[demo] Seeded trending topics');
}
