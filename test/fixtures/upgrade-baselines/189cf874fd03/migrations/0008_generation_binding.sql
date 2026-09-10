-- Bind live assessments and model jobs to the fixture generation they were
-- prepared in, so a reset makes reference evidence current again and old
-- live results and jobs never leak into a restored scenario.
ALTER TABLE asset_assessments
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);
ALTER TABLE risk_assessments
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);
ALTER TABLE model_jobs
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);

-- One logical job per generation: a succeeded job from before a reset is
-- evidence, not a reusable result for the restored scenario.
DROP INDEX model_jobs_logical_unique;
CREATE UNIQUE INDEX model_jobs_logical_unique
  ON model_jobs (
    purpose,
    draft_id,
    input_hash,
    corpus_hash,
    prompt_version,
    request_generation
  );
