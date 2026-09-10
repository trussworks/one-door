-- Durable model-preparation jobs: one logical job per purpose, effective
-- input, and corpus; PostgreSQL leases; at most one automatic retry.
CREATE TYPE model_job_status AS ENUM (
  'queued',
  'leased',
  'succeeded',
  'failed',
  'capped',
  'superseded'
);

CREATE TABLE model_jobs (
  id uuid PRIMARY KEY,
  purpose model_purpose NOT NULL,
  draft_id uuid NOT NULL REFERENCES drafts (id),
  request_id uuid REFERENCES requests (id),
  revision_id uuid REFERENCES request_content_revisions (id),
  visitor_id uuid REFERENCES visitors (id),
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  corpus_hash text NOT NULL CHECK (length(corpus_hash) = 64),
  prompt_version text NOT NULL CHECK (length(trim(prompt_version)) > 0),
  status model_job_status NOT NULL,
  attempt_count smallint NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 2),
  lease_owner text,
  lease_expires_at timestamptz,
  current_model_call_id uuid REFERENCES model_calls (id),
  sanitized_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A lease exists exactly while the job is leased.
  CHECK (
    (status = 'leased'
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'leased'
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    status NOT IN ('failed', 'capped')
    OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)
  )
);

CREATE UNIQUE INDEX model_jobs_logical_unique
  ON model_jobs (purpose, draft_id, input_hash, corpus_hash);
CREATE INDEX model_jobs_ready_idx
  ON model_jobs (status, lease_expires_at, created_at);
CREATE INDEX model_jobs_draft_idx ON model_jobs (draft_id, purpose);
