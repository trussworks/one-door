-- Clarification round trip and immutable request-content revisions.
-- Waiting-on-requester is not a request stage: an unanswered row in
-- clarification_requests is the waiting state, so the review lifecycle and the
-- conversation overlay cannot disagree.
CREATE TYPE revision_source AS ENUM ('submission', 'clarification_answer');

-- Live display ids start at 2000; seeded fixtures occupy the OD-1xxx range.
CREATE SEQUENCE request_display_id_seq START 2000;

CREATE TABLE request_content_revisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests (id),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  content jsonb NOT NULL,
  source revision_source NOT NULL,
  authored_by_actor_id uuid NOT NULL REFERENCES actors (id),
  visitor_id uuid REFERENCES visitors (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, revision_number),
  UNIQUE (id, request_id)
);
CREATE TRIGGER request_content_revisions_immutable
  BEFORE UPDATE OR DELETE ON request_content_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE clarification_requests (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests (id),
  revision_id uuid NOT NULL,
  question text NOT NULL CHECK (length(trim(question)) > 0),
  asked_by_actor_id uuid NOT NULL REFERENCES actors (id),
  asked_at timestamptz NOT NULL DEFAULT now(),
  answer text,
  answered_at timestamptz,
  answer_revision_id uuid,
  origin data_origin NOT NULL,
  FOREIGN KEY (revision_id, request_id)
    REFERENCES request_content_revisions (id, request_id),
  FOREIGN KEY (answer_revision_id, request_id)
    REFERENCES request_content_revisions (id, request_id),
  CHECK (
    (answered_at IS NULL AND answer IS NULL AND answer_revision_id IS NULL)
    OR (
      answered_at IS NOT NULL
      AND answer IS NOT NULL
      AND length(trim(answer)) > 0
      AND answer_revision_id IS NOT NULL
    )
  )
);
CREATE INDEX clarification_requests_request_idx
  ON clarification_requests (request_id, asked_at);
CREATE UNIQUE INDEX clarification_requests_one_open
  ON clarification_requests (request_id)
  WHERE answered_at IS NULL;

ALTER TABLE requests ADD COLUMN current_revision_id uuid;
ALTER TABLE requests
  ADD CONSTRAINT requests_current_revision_fk
  FOREIGN KEY (current_revision_id, id)
  REFERENCES request_content_revisions (id, request_id);

-- An assessment cites the content revision it evaluated; NULL means it
-- predates revision tracking (fixture assessments attached to drafts).
ALTER TABLE asset_assessments
  ADD COLUMN revision_id uuid REFERENCES request_content_revisions (id);
ALTER TABLE risk_assessments
  ADD COLUMN revision_id uuid REFERENCES request_content_revisions (id);
