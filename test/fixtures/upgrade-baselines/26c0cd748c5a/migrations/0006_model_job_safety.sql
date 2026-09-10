-- Lease ownership tokens, immutable input/corpus snapshots, prompt-aware
-- logical identity, and same-parent link enforcement for model jobs.
ALTER TABLE model_jobs
  ADD COLUMN lease_token uuid,
  ADD COLUMN input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN corpus_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The token survives settlement as last-owner evidence; it must exist while
-- the lease is held.
ALTER TABLE model_jobs ADD CONSTRAINT model_jobs_lease_token_check
  CHECK (status <> 'leased' OR lease_token IS NOT NULL);

-- The snapshots are the inspectable evidence of what the job evaluated; a
-- later draft edit must not rewrite them.
CREATE FUNCTION protect_model_job_snapshots() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
     OR NEW.corpus_snapshot IS DISTINCT FROM OLD.corpus_snapshot THEN
    RAISE EXCEPTION 'model_job_snapshot_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_jobs_snapshots_immutable
  BEFORE UPDATE ON model_jobs
  FOR EACH ROW EXECUTE FUNCTION protect_model_job_snapshots();

-- A changed prompt is a new logical job; old succeeded jobs must not be
-- silently reused under a different prompt.
DROP INDEX model_jobs_logical_unique;
CREATE UNIQUE INDEX model_jobs_logical_unique
  ON model_jobs (purpose, draft_id, input_hash, corpus_hash, prompt_version);

-- Same-parent enforcement: the job's request must come from the job's draft,
-- and the job's revision must belong to the job's request.
CREATE UNIQUE INDEX requests_id_draft_unique
  ON requests (id, source_draft_id);
ALTER TABLE model_jobs
  ADD CONSTRAINT model_jobs_request_same_draft_fk
    FOREIGN KEY (request_id, draft_id)
    REFERENCES requests (id, source_draft_id),
  ADD CONSTRAINT model_jobs_revision_same_request_fk
    FOREIGN KEY (revision_id, request_id)
    REFERENCES request_content_revisions (id, request_id),
  ADD CONSTRAINT model_jobs_revision_needs_request_check
    CHECK (revision_id IS NULL OR request_id IS NOT NULL);
