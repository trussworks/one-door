CREATE TRIGGER review_input_responses_immutable
  BEFORE UPDATE OR DELETE ON review_input_responses
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
