-- Phase 2 of the CRM upgrade: pg_notify triggers so the Postgres → Neo4j
-- sync (lib/graph/sync.js) mirrors contacts, identities, orgs, and project
-- memberships in real time as they're inserted/updated/deleted.
--
-- Channel names mirror the existing pattern used by task_completed /
-- intent_decided / draft_reviewed in lib/graph/sync.js. The handlers in
-- sync.js do the actual MERGE / DELETE Cypher; these triggers just fire.

-- Generic trigger function: emits a JSON payload onto a channel determined
-- by TG_ARGV[0]. Payload is { op, id, ...row_snapshot }. For delete events
-- only id is reliably present (we use OLD).
CREATE OR REPLACE FUNCTION signal.notify_graph_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  channel  TEXT := TG_ARGV[0];
  op       TEXT;
  payload  JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    op := 'insert';
    payload := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    op := 'update';
    payload := to_jsonb(NEW);
  ELSE
    op := 'delete';
    payload := jsonb_build_object('id', OLD.id);
  END IF;

  payload := payload || jsonb_build_object('op', op);
  -- pg_notify caps payloads at 8000 bytes; we keep these small by design
  -- (no large text columns). If payload ever exceeds, the handler can
  -- re-fetch from Postgres on a single-id signal.
  PERFORM pg_notify(channel, payload::text);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- contacts → :Person
DROP TRIGGER IF EXISTS contacts_notify_graph ON signal.contacts;
CREATE TRIGGER contacts_notify_graph
  AFTER INSERT OR UPDATE OR DELETE ON signal.contacts
  FOR EACH ROW EXECUTE FUNCTION signal.notify_graph_change('contact_changed');

-- contact_identities → :Identity (hangs off :Person via HAS_IDENTITY)
DROP TRIGGER IF EXISTS contact_identities_notify_graph ON signal.contact_identities;
CREATE TRIGGER contact_identities_notify_graph
  AFTER INSERT OR UPDATE OR DELETE ON signal.contact_identities
  FOR EACH ROW EXECUTE FUNCTION signal.notify_graph_change('identity_changed');

-- organizations → :Organization
DROP TRIGGER IF EXISTS organizations_notify_graph ON signal.organizations;
CREATE TRIGGER organizations_notify_graph
  AFTER INSERT OR UPDATE OR DELETE ON signal.organizations
  FOR EACH ROW EXECUTE FUNCTION signal.notify_graph_change('organization_changed');

-- contact_projects → :Project + (Person)-[:MEMBER_OF]->(Project)
DROP TRIGGER IF EXISTS contact_projects_notify_graph ON signal.contact_projects;
CREATE TRIGGER contact_projects_notify_graph
  AFTER INSERT OR UPDATE OR DELETE ON signal.contact_projects
  FOR EACH ROW EXECUTE FUNCTION signal.notify_graph_change('project_membership_changed');
