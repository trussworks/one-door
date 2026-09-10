CREATE TABLE review_input_requests (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests (id),
  revision_id uuid REFERENCES request_content_revisions (id),
  request_generation integer NOT NULL CHECK (request_generation > 0),
  area review_area NOT NULL,
  audience text NOT NULL CHECK (audience IN ('internal', 'requester')),
  factor text,
  candidate_id uuid REFERENCES asset_candidates (id),
  finding_id uuid REFERENCES risk_findings (id),
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 2000),
  scope text,
  expertise text,
  asked_by_actor_id uuid NOT NULL REFERENCES actors (id),
  asked_by_visitor_id uuid REFERENCES visitors (id),
  assignee_actor_id uuid REFERENCES actors (id),
  assigned_by_actor_id uuid REFERENCES actors (id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'resolved')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  resolved_by_actor_id uuid REFERENCES actors (id),
  resolution_kind text,
  resolution_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_input_requests_target_check CHECK (
    (factor IS NULL OR (area = 'rice' AND factor IN ('reach', 'impact', 'confidence', 'effort')))
    AND (candidate_id IS NULL OR area = 'assets')
    AND (finding_id IS NULL OR area = 'risk')
  ),
  CONSTRAINT review_input_requests_requester_check CHECK (
    audience <> 'requester' OR assignee_actor_id IS NULL
  ),
  CONSTRAINT review_input_requests_resolution_check CHECK (
    (state = 'resolved' AND resolved_by_actor_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_id IS NOT NULL AND resolution_kind IN
        ('candidate_decision', 'risk_decision', 'priority_contribution', 'area_outcome'))
    OR (state <> 'resolved' AND resolved_by_actor_id IS NULL AND resolved_at IS NULL
      AND resolution_id IS NULL AND resolution_kind IS NULL)
  )
);

CREATE INDEX review_input_requests_request_idx ON review_input_requests (request_id, created_at);
CREATE INDEX review_input_requests_assignee_idx ON review_input_requests (assignee_actor_id, state);
CREATE INDEX review_input_requests_asker_idx ON review_input_requests (asked_by_actor_id, state);

CREATE TABLE review_input_responses (
  id uuid PRIMARY KEY,
  input_request_id uuid NOT NULL REFERENCES review_input_requests (id),
  input_version integer NOT NULL CHECK (input_version > 0),
  revision_id uuid REFERENCES request_content_revisions (id),
  request_generation integer NOT NULL CHECK (request_generation > 0),
  answer text NOT NULL CHECK (length(trim(answer)) BETWEEN 1 AND 5000),
  outcome text NOT NULL CHECK (outcome IN ('provided', 'unknown')),
  respondent_actor_id uuid NOT NULL REFERENCES actors (id),
  recorded_by_actor_id uuid NOT NULL REFERENCES actors (id),
  visitor_id uuid REFERENCES visitors (id),
  contribution_id uuid REFERENCES priority_contributions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_input_responses_version_unique UNIQUE (input_request_id, input_version),
  CONSTRAINT review_input_responses_unknown_check CHECK (outcome <> 'unknown' OR contribution_id IS NULL)
);
