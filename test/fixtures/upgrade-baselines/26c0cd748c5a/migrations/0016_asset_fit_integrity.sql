-- Enforce what 0013 claimed. Insert-only was documentation until now: no
-- trigger guarded asset_fit_decisions. Same-draft ancestry was two separate
-- foreign keys, so a decision could name a candidate from another draft.
-- The assessment_id column completes the composite-key chain the schema
-- already uses for candidates: decision -> (candidate, assessment) ->
-- (assessment, draft).
ALTER TABLE asset_assessments
  ADD CONSTRAINT asset_assessments_id_draft_unique UNIQUE (id, draft_id);

ALTER TABLE asset_fit_decisions
  ADD COLUMN assessment_id uuid;

UPDATE asset_fit_decisions d
SET assessment_id = c.assessment_id
FROM asset_candidates c
WHERE c.id = d.candidate_id;

ALTER TABLE asset_fit_decisions
  ALTER COLUMN assessment_id SET NOT NULL;

ALTER TABLE asset_fit_decisions
  ADD CONSTRAINT asset_fit_decisions_candidate_ancestry_fk
    FOREIGN KEY (candidate_id, assessment_id)
    REFERENCES asset_candidates (id, assessment_id),
  ADD CONSTRAINT asset_fit_decisions_draft_ancestry_fk
    FOREIGN KEY (assessment_id, draft_id)
    REFERENCES asset_assessments (id, draft_id);

CREATE TRIGGER asset_fit_decisions_immutable
  BEFORE UPDATE OR DELETE ON asset_fit_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
