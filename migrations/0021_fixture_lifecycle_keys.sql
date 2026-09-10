-- Seeded lifecycle examples need fixture-owned delivery handoffs, resolutions,
-- and clarifications that survive a fixture reset. The generation-advance step
-- exempts fixture-owned evidence (fixture_key IS NULL means a live row); these
-- tables lacked the column, so seeded rows stranded on the first reset. The
-- column is nullable, so every existing (live) row keeps fixture_key NULL and
-- stays a live row. The unique index treats NULLs as distinct, so live rows are
-- unconstrained while each fixture row keeps one stable key.
ALTER TABLE clarification_requests ADD COLUMN fixture_key text;
ALTER TABLE delivery_handoffs ADD COLUMN fixture_key text;
ALTER TABLE request_resolutions ADD COLUMN fixture_key text;

CREATE UNIQUE INDEX clarification_requests_fixture_key_unique
  ON clarification_requests (fixture_key);
CREATE UNIQUE INDEX delivery_handoffs_fixture_key_unique
  ON delivery_handoffs (fixture_key);
CREATE UNIQUE INDEX request_resolutions_fixture_key_unique
  ON request_resolutions (fixture_key);
