-- Bind human review decisions to the fixture generation they were made in,
-- mirroring the assessment binding from 0008. Existing rows keep generation 1;
-- fixture-origin rows stay valid at any generation (origin escape), so no
-- historical evidence is rewritten.
ALTER TABLE rice_scores
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1;
ALTER TABLE asset_candidate_decisions
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1;
ALTER TABLE risk_finding_decisions
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1;
