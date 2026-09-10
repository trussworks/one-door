ALTER TABLE asset_candidates ALTER COLUMN fit_band DROP NOT NULL;
ALTER TABLE asset_candidates ADD COLUMN proposed_by_actor_id uuid REFERENCES actors(id);
ALTER TABLE asset_candidates ADD CONSTRAINT asset_candidates_fit_source_check
  CHECK (fit_band IS NOT NULL OR proposed_by_actor_id IS NOT NULL);

CREATE TRIGGER priority_contributions_immutable
  BEFORE UPDATE OR DELETE ON priority_contributions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER priority_decisions_immutable
  BEFORE UPDATE OR DELETE ON priority_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
