-- Fixture generations: a reset advances a fixture request's generation so
-- preserved live completions, resolutions, handoffs, and open clarifications
-- stop binding the restored scenario without deleting any evidence.
ALTER TABLE requests
  ADD COLUMN fixture_generation integer NOT NULL DEFAULT 1
    CHECK (fixture_generation > 0);

ALTER TABLE task_completions
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);
ALTER TABLE request_resolutions
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);
ALTER TABLE delivery_handoffs
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);
ALTER TABLE clarification_requests
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1
    CHECK (request_generation > 0);

-- Once-per-request rules now hold per generation; rows from earlier
-- generations remain immutable evidence.
DROP INDEX task_completions_once_per_request;
CREATE UNIQUE INDEX task_completions_once_per_request
  ON task_completions (request_id, task_type, request_generation);
ALTER TABLE task_completions
  DROP CONSTRAINT task_completions_actor_id_task_type_request_id_key;
CREATE UNIQUE INDEX task_completions_actor_task_request_unique
  ON task_completions (
    actor_id,
    task_type,
    request_id,
    request_generation
  );
ALTER TABLE request_resolutions
  DROP CONSTRAINT request_resolutions_request_id_key;
CREATE UNIQUE INDEX request_resolutions_request_unique
  ON request_resolutions (request_id, request_generation);
ALTER TABLE delivery_handoffs
  DROP CONSTRAINT delivery_handoffs_request_id_key;
CREATE UNIQUE INDEX delivery_handoffs_request_unique
  ON delivery_handoffs (request_id, request_generation);
DROP INDEX clarification_requests_one_open;
CREATE UNIQUE INDEX clarification_requests_one_open
  ON clarification_requests (request_id, request_generation)
  WHERE answered_at IS NULL;
