-- Post-approval follow-up: a scope change after first review or resolution
-- starts a new draft linked to the completed parent request. The relation is
-- set at creation and never mutates the parent.
ALTER TABLE drafts
  ADD COLUMN parent_request_id uuid REFERENCES requests (id);

CREATE INDEX drafts_parent_request_idx
  ON drafts (parent_request_id)
  WHERE parent_request_id IS NOT NULL;
