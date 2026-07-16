// Shared types for the /today page. Kept narrow on purpose — anything
// broader is unused after the 2026-05 simplification.

export interface Signal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  direction: string | null;
  domain: string | null;
  created_at: string;
  message_id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  received_at: string;
  channel: string;
  webhook_source: string | null;
  contact_type: string | null;
  is_vip: boolean;
  tier: string | null;
  account_label: string | null;
  metadata?: Record<string, unknown>;
}
