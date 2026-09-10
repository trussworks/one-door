-- Bind a completed review area to the assessment it actually reviewed. When
-- a corpus reverts (A -> B -> A) the cached A result becomes current again,
-- and a completion recorded against B must not approve the unreviewed A.
-- Existing completed rows keep NULL and therefore read as needing a fresh
-- outcome for whatever is current; no history is rewritten.
ALTER TABLE review_tasks ADD COLUMN completed_assessment_id uuid;
