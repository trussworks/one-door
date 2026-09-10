-- Retain the catalog item's name as it read when the model proposed the
-- candidate. Later catalog edits must not rewrite what the requester saw.
-- Rows from before this migration have no captured name; reads fall back to
-- the live catalog name, the best record that exists for them.
ALTER TABLE asset_candidates
  ADD COLUMN name text;
