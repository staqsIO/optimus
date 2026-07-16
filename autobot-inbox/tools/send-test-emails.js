#!/usr/bin/env node
/**
 * Send real test emails from a second Gmail account to eric@staqs.io.
 * These arrive in the real inbox and get picked up by the pipeline.
 *
 * Setup:
 *   1. Run: node tools/setup-sender.js
 *      (creates App Password credentials — saves to .env.sender)
 *   2. Run: node tools/send-test-emails.js [--count N] [--delay SECONDS]
 *
 * Requires .env.sender with SENDER_EMAIL and SENDER_APP_PASSWORD.
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { createTransport } from 'nodemailer';

// Load sender credentials from .env.sender
let senderEmail;
let senderAppPassword;
try {
  const senderEnv = readFileSync(
    new URL('../.env.sender', import.meta.url),
    'utf-8'
  );
  senderEmail = senderEnv.match(/SENDER_EMAIL=(.+)/)?.[1]?.trim();
  senderAppPassword = senderEnv.match(/SENDER_APP_PASSWORD=(.+)/)?.[1]?.trim();
} catch {
  // fall through
}

if (!senderEmail || !senderAppPassword) {
  console.error('Missing sender credentials. Run: node tools/setup-sender.js');
  process.exit(1);
}

const TARGET_EMAIL = process.env.GMAIL_USER_EMAIL || 'eric@staqs.io';

// Parse args
const args = process.argv.slice(2);
const countIdx = args.indexOf('--count');
const delayIdx = args.indexOf('--delay');
const count = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : null;
const delaySec = delayIdx >= 0 ? parseInt(args[delayIdx + 1], 10) : 3;

// -------------------------------------------------------------------
// Test email templates — realistic Staqs agency business scenarios
// -------------------------------------------------------------------

const SENDER_NAME = 'Gang Liu';

const TEMPLATES = [
  {
    subject: 'New website project inquiry - e-commerce startup',
    body: `Hey Eric,

I was referred to Staqs by a friend who said you guys built their Shopify store. I'm starting a DTC skincare brand and need a full e-commerce site.

Budget is around $15-20k. We'd want product pages, a subscription model, and integration with our fulfillment provider (ShipBob).

Timeline wise, we're hoping to launch by end of Q2. Is that realistic?

Can we hop on a call this week to discuss?

Gang`,
  },
  {
    subject: 'Re: Builder.io migration - staging issues',
    body: `Eric,

We're running into some problems on the staging site after the Builder.io migration. A few things:

1. The hero section on the homepage isn't rendering on mobile - just shows a blank white space
2. The blog post templates lost their custom styling (fonts reverted to defaults)
3. Page load times went from 1.2s to 3.8s on the product pages

Can your team take a look? The client demo is Thursday and we need this cleaned up before then.

Thanks,
Gang`,
  },
  {
    subject: 'SEO audit results - priority action items',
    body: `Hi Eric,

Finished the SEO audit for the Frontpoint site. Some key findings:

- 47 pages with duplicate meta descriptions
- Core Web Vitals failing on mobile (LCP is 4.2s, needs to be under 2.5s)
- The new partner portal pages aren't indexed at all - looks like a robots.txt issue
- Backlink profile is solid but we're losing rankings on "home security system" keywords

I put together a prioritized list. Can we go through it together? Most of the technical SEO fixes should be straightforward for your dev team.

Let me know when you have 30 min.

Gang`,
  },
  {
    subject: 'Invoice question - October hours',
    body: `Eric,

Quick question on the October invoice. I'm seeing 42 hours billed for the Empire Asset Finance project but our internal tracking shows closer to 35. Can you break down what the extra hours were for?

Also, the hourly rate on the AutoCSR work looks different from what we agreed on in the SOW. It shows $175/hr but I thought we locked in $150/hr for that project.

Want to get this sorted before we process payment.

Thanks,
Gang`,
  },
  {
    subject: 'Partnership opportunity - AI customer service tool',
    body: `Hey Eric,

I've been following what you guys are doing with AutoCSR and I think there's a natural fit with our platform. We're building an AI-powered customer service tool for mid-market SaaS companies and your white-label approach could work well for our enterprise clients.

Would you be open to exploring a reseller or integration partnership? We have about 200 active clients who are asking for exactly this kind of solution.

Happy to put together a more detailed proposal if you're interested.

Gang`,
  },
  {
    subject: 'Urgent - client site is down',
    body: `Eric,

The OCAS website is throwing 500 errors. Noticed it about 20 minutes ago. Their team is in a board meeting showing the site to stakeholders right now.

Can someone look at this ASAP? I checked the Vercel dashboard and the latest deployment looks like it failed but I don't have access to roll back.

Gang`,
  },
  {
    subject: 'Re: Quarterly roadmap planning',
    body: `Eric,

Thanks for sharing the Q2 roadmap draft. A few thoughts:

The Builder.io component library work makes sense as priority #1. Our clients keep asking for reusable sections and it would cut our build times significantly.

I'm less sure about the headless CMS migration for Empire. They seem happy with WordPress and pushing them to something new feels risky mid-contract. Can we defer that to Q3?

Also want to flag - we're getting more inbound for Shopify Plus projects. Might be worth investing in that capability if we're seeing the demand.

Let's discuss at the team sync tomorrow.

Gang`,
  },
  {
    subject: 'Proposal feedback - N2 Communications rebrand',
    body: `Hi Eric,

Reviewed the proposal for the N2 Communications rebrand and site rebuild. Overall looks great but I have some notes:

- The $45k estimate feels light for the scope. With the custom CMS integrations and multilingual support, I'd budget closer to $55-60k.
- Timeline of 8 weeks is aggressive. Their brand guidelines aren't finalized yet so we should pad for that.
- Love the Builder.io approach for their marketing pages. That'll save them a ton on ongoing content updates.

One more thing - they asked if we can include ongoing maintenance in the proposal. Something like 10 hrs/month retainer. Worth adding as an optional line item.

Gang`,
  },
];

// -------------------------------------------------------------------
// Send logic
// -------------------------------------------------------------------

async function main() {
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: senderEmail,
      pass: senderAppPassword,
    },
  });

  // Verify connection
  await transporter.verify();
  console.log(`Sender: ${senderEmail} (as ${SENDER_NAME})`);
  console.log(`Target: ${TARGET_EMAIL}\n`);

  const toSend = count
    ? TEMPLATES.slice(0, Math.min(count, TEMPLATES.length))
    : TEMPLATES;

  console.log(`Sending ${toSend.length} emails with ${delaySec}s delay between each...\n`);

  for (let i = 0; i < toSend.length; i++) {
    const template = toSend[i];

    const info = await transporter.sendMail({
      from: `${SENDER_NAME} <${senderEmail}>`,
      to: TARGET_EMAIL,
      subject: template.subject,
      text: template.body,
    });

    console.log(`  [${i + 1}/${toSend.length}] "${template.subject}" → ${info.messageId}`);

    // Delay between sends (except last)
    if (i < toSend.length - 1 && delaySec > 0) {
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }

  console.log(`\nDone! ${toSend.length} emails sent to ${TARGET_EMAIL}.`);
  console.log('Pipeline will pick them up on the next Gmail poll (up to 60s).');
  console.log('Watch the dashboard at http://localhost:3100 for activity.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
