ALTER TABLE asset_fit_decisions
  DROP CONSTRAINT asset_fit_decisions_decision_check,
  ADD CONSTRAINT asset_fit_decisions_decision_check
    CHECK (decision IN ('accepted', 'rejected', 'cleared'));
