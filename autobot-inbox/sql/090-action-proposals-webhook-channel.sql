-- 090: extend action_proposals.channel CHECK to accept 'webhook'.
--
-- Background
-- ----------
-- inbox.messages.channel already accepts 'webhook' (and uses it heavily —
-- 409 webhook messages in the last 14 days vs 674 email messages). When
-- the responder drafts a reply for a webhook-class message, it propagates
-- channel='webhook' to action_proposals — and slams into a CHECK that
-- only knows about email/slack/whatsapp/telegram. Three retry-exhausted
-- failures in 24h before this fix.
--
-- This is the same bug class PR #150 fixed for tone_score: a downstream
-- CHECK rejects a value the producer code can legitimately emit. Phase A's
-- loud-failures trigger (PR #151) catches these at runtime; the property-
-- test ratchet (PR #151) is supposed to catch them at PR time, but only
-- runs against `verified` manifest entries — channel was `documented`.
-- This PR also promotes the entry to `verified` and adds the property
-- test, so a future channel addition will fail CI.

ALTER TABLE agent_graph.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_channel_check;

ALTER TABLE agent_graph.action_proposals
  ADD CONSTRAINT action_proposals_channel_check
  CHECK (channel IS NULL OR channel IN ('email', 'slack', 'whatsapp', 'telegram', 'webhook'));
