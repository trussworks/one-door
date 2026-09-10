-- Requester asset-fit decisions: the requester's own accepted/rejected verdict
-- on a recommended existing asset, separate from reviewer candidate decisions.
-- Insert-only history; currency derives from the candidate's assessment call.
CREATE TABLE asset_fit_decisions (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES drafts(id),
  candidate_id uuid NOT NULL REFERENCES asset_candidates(id),
  decision candidate_decision NOT NULL,
  reason text,
  visitor_id uuid NOT NULL REFERENCES visitors(id),
  actor_id uuid NOT NULL REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_fit_decisions_decision_check
    CHECK (decision IN ('accepted', 'rejected')),
  CONSTRAINT asset_fit_decisions_reason_check
    CHECK (decision <> 'rejected'
      OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);

CREATE INDEX asset_fit_decisions_draft_idx ON asset_fit_decisions (draft_id);
