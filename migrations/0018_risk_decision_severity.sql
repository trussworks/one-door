-- A final severity is meaningful only on an override. Interfaces have
-- carried a previously selected severity into other decisions; the check
-- makes a contradictory non-override severity unstorable.
ALTER TABLE risk_finding_decisions
  ADD CONSTRAINT risk_finding_decisions_override_severity_check
    CHECK (final_severity IS NULL OR decision = 'overridden');
