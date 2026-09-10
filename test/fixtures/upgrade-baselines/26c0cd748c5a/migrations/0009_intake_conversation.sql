-- Intake conversation and explicit adoption: answers reply to generated
-- question turns, and a draft records which intake result its confirmed
-- content adopted.
ALTER TABLE drafts
  ADD COLUMN confirmed_intake_job_id uuid REFERENCES model_jobs (id);

ALTER TABLE draft_turns
  ADD COLUMN reply_to_turn_id uuid REFERENCES draft_turns (id);
CREATE UNIQUE INDEX draft_turns_one_answer
  ON draft_turns (reply_to_turn_id)
  WHERE reply_to_turn_id IS NOT NULL;
