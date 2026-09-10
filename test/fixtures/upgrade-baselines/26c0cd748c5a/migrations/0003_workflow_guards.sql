CREATE FUNCTION require_assessment_revision_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM request_content_revisions revision
    JOIN requests request ON request.id = revision.request_id
    WHERE revision.id = NEW.revision_id AND request.source_draft_id = NEW.draft_id
  ) THEN
    RAISE EXCEPTION 'assessment_revision_owner_mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_assessment_revision_owner
BEFORE INSERT ON asset_assessments FOR EACH ROW
EXECUTE FUNCTION require_assessment_revision_owner();

CREATE TRIGGER risk_assessment_revision_owner
BEFORE INSERT ON risk_assessments FOR EACH ROW
EXECUTE FUNCTION require_assessment_revision_owner();

CREATE TABLE demo_gate_attempts (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  window_started_at timestamptz NOT NULL
);
