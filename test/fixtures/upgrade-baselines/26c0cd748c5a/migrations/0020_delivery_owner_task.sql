-- Structured delivery ownership: a named accountable person and a separate
-- next task. The legacy next_owner text stays for old rows and handoff
-- snapshots; the pair is written together or not at all.
ALTER TABLE requests
  ADD COLUMN delivery_owner_actor_id uuid REFERENCES actors (id),
  ADD COLUMN next_task text
    CONSTRAINT requests_next_task_check
    CHECK (next_task IS NULL OR length(trim(next_task)) > 0),
  ADD CONSTRAINT requests_delivery_pair_check CHECK (
    (delivery_owner_actor_id IS NULL) = (next_task IS NULL)
  );
