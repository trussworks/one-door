-- Review completion, simulated delivery handoff, and human resolution.
CREATE TYPE handoff_status AS ENUM ('intended', 'confirmed', 'failed');
CREATE TYPE resolution_outcome AS ENUM (
  'fulfilled_reuse',
  'fulfilled_new',
  'fulfilled_mixed',
  'closed_without_fulfillment'
);

-- The named next owner or path recorded by human routing or first-review
-- completion. Caller-provided content, never authored by the workflow layer.
ALTER TABLE requests ADD COLUMN next_owner text;

-- Simulated delivery items close through the demo status path; NULL means the
-- source system still reports the work open.
ALTER TABLE external_work_items ADD COLUMN closed_at timestamptz;

-- A milestone and its rating happen once per request, not once per visitor.
CREATE UNIQUE INDEX task_completions_once_per_request
  ON task_completions (request_id, task_type);

CREATE TABLE delivery_handoffs (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES requests (id),
  target_system external_system NOT NULL,
  next_owner text NOT NULL CHECK (length(trim(next_owner)) > 0),
  work_plan jsonb NOT NULL,
  retry_key text NOT NULL UNIQUE,
  status handoff_status NOT NULL,
  sanitized_error text,
  confirmed_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'confirmed' AND confirmed_at IS NOT NULL)
    OR (status <> 'confirmed' AND confirmed_at IS NULL)
  ),
  CHECK (
    status <> 'failed'
    OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)
  )
);

CREATE TABLE request_resolutions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES requests (id),
  outcome resolution_outcome NOT NULL,
  summary text NOT NULL CHECK (length(trim(summary)) > 0),
  reason text,
  resolved_by_actor_id uuid NOT NULL REFERENCES actors (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    outcome <> 'closed_without_fulfillment'
    OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  )
);
CREATE TRIGGER request_resolutions_immutable
  BEFORE UPDATE OR DELETE ON request_resolutions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
