CREATE TABLE priority_contributions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id),
  revision_id uuid,
  request_generation integer NOT NULL CHECK (request_generation > 0),
  factor text NOT NULL CHECK (factor IN ('reach', 'impact', 'confidence', 'effort')),
  estimate jsonb NOT NULL CHECK (jsonb_typeof(estimate) = 'object'),
  source text NOT NULL CHECK (source IN ('requester', 'contributor')),
  supplied_by_actor_id uuid NOT NULL REFERENCES actors(id),
  recorded_by_actor_id uuid NOT NULL REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT priority_contributions_parent_unique UNIQUE (id, request_id, factor),
  CONSTRAINT priority_contributions_revision_fk FOREIGN KEY (revision_id, request_id)
    REFERENCES request_content_revisions(id, request_id)
);
CREATE INDEX priority_contributions_request_idx ON priority_contributions(request_id, request_generation);

CREATE TABLE priority_decisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id),
  revision_id uuid,
  request_generation integer NOT NULL CHECK (request_generation > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  factor text NOT NULL CHECK (factor IN ('reach', 'impact', 'confidence', 'effort')),
  action text NOT NULL CHECK (action IN ('adopt', 'replace', 'reject')),
  proposal_id uuid,
  estimate jsonb,
  supplied_by_actor_id uuid REFERENCES actors(id),
  recorded_by_actor_id uuid NOT NULL REFERENCES actors(id),
  reviewer_actor_id uuid NOT NULL REFERENCES actors(id),
  base_score_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT priority_decisions_sequence_unique UNIQUE (request_id, sequence),
  CONSTRAINT priority_decisions_proposal_fk FOREIGN KEY (proposal_id, request_id, factor)
    REFERENCES priority_contributions(id, request_id, factor),
  CONSTRAINT priority_decisions_revision_fk FOREIGN KEY (revision_id, request_id)
    REFERENCES request_content_revisions(id, request_id),
  CONSTRAINT priority_decisions_base_score_fk FOREIGN KEY (base_score_id, request_id)
    REFERENCES rice_scores(id, request_id),
  CONSTRAINT priority_decisions_adopt_check CHECK (action <> 'adopt' OR proposal_id IS NOT NULL),
  CONSTRAINT priority_decisions_value_check CHECK (
    (action = 'reject' AND estimate IS NULL AND supplied_by_actor_id IS NULL
      AND reason IS NOT NULL AND length(trim(reason)) > 0)
    OR (action IN ('adopt', 'replace') AND estimate IS NOT NULL
      AND jsonb_typeof(estimate) = 'object' AND supplied_by_actor_id IS NOT NULL)
  )
);
