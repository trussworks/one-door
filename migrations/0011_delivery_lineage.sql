-- Bind each delivery link to the handoff and fixture generation that made
-- it, so a reset's later generation reads earlier links as history instead
-- of current work. Existing rows keep generation 1 with no handoff: live
-- links (generation 1 forever) stay current, and fixture links become
-- historical only when a reset advances their request. Nothing is deleted.
ALTER TABLE request_work_item_links
  ADD COLUMN handoff_id uuid REFERENCES delivery_handoffs (id),
  ADD COLUMN request_generation integer NOT NULL DEFAULT 1;
ALTER TABLE request_work_item_links
  DROP CONSTRAINT request_work_item_links_pkey,
  ADD PRIMARY KEY (request_id, work_item_id, request_generation);
