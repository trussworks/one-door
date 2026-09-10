-- Stable draft creation: a caller-generated creation key makes the initial
-- create replayable after a lost response. The stored input hash detects a
-- conflicting reuse of the same key.
ALTER TABLE drafts
  ADD COLUMN creation_key text,
  ADD COLUMN creation_input_hash text;

ALTER TABLE drafts
  ADD CONSTRAINT drafts_creation_key_pair_check
    CHECK ((creation_key IS NULL) = (creation_input_hash IS NULL));

CREATE UNIQUE INDEX drafts_creation_key_unique ON drafts (creation_key);
