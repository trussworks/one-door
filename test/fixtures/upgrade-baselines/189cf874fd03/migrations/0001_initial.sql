CREATE TYPE acting_view AS ENUM ('requester', 'contributor', 'administrator');
CREATE TYPE actor_kind AS ENUM ('persona', 'visitor', 'system');
CREATE TYPE organization_kind AS ENUM ('agency', 'office', 'team');
CREATE TYPE data_origin AS ENUM ('fixture', 'live', 'system');
CREATE TYPE draft_state AS ENUM ('open', 'ready', 'submitted');
CREATE TYPE turn_actor AS ENUM ('customer', 'assistant');
CREATE TYPE request_stage AS ENUM ('submitted', 'under_review', 'first_review_completed');
CREATE TYPE routing_state AS ENUM ('service_selected', 'routing_requested');
CREATE TYPE model_purpose AS ENUM ('intake_interpret', 'asset_match', 'risk_assess');
CREATE TYPE model_status AS ENUM ('reserved', 'succeeded', 'failed', 'denied');
CREATE TYPE lifecycle_state AS ENUM ('active', 'retired');
CREATE TYPE fit_band AS ENUM ('strong', 'possible', 'weak');
CREATE TYPE candidate_decision AS ENUM ('accepted', 'rejected', 'cleared');
CREATE TYPE task_type AS ENUM ('requester_submission', 'contributor_first_review');
CREATE TYPE sync_status AS ENUM ('running', 'succeeded', 'failed');
CREATE TYPE source_record_state AS ENUM ('present', 'stale');
CREATE TYPE conflict_state AS ENUM ('open', 'resolved', 'reopened');
CREATE TYPE catalog_state AS ENUM ('draft', 'published', 'retired');
CREATE TYPE approval_status AS ENUM ('approved', 'conditional', 'review_required');
CREATE TYPE catalog_item_type AS ENUM ('software', 'infrastructure', 'platform');
CREATE TYPE review_area AS ENUM ('assets', 'risk', 'rice');
CREATE TYPE review_task_state AS ENUM ('pending', 'in_progress', 'completed');
CREATE TYPE assessment_status AS ENUM ('succeeded', 'failed');
CREATE TYPE risk_domain AS ENUM ('policy', 'accessibility', 'security', 'privacy', 'ai', 'procurement');
CREATE TYPE risk_kind AS ENUM ('supported_risk', 'missing_information');
CREATE TYPE risk_severity AS ENUM ('low', 'moderate', 'high', 'critical');
CREATE TYPE risk_decision AS ENUM ('confirmed', 'overridden', 'follow_up_required', 'cleared');
CREATE TYPE external_system AS ENUM ('servicenow', 'azure_devops');
CREATE TYPE sync_health AS ENUM ('current', 'stale', 'failed');

CREATE TABLE _one_door_fixture_seed (
  name text PRIMARY KEY,
  content_hash text NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION protect_versioned_reference_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_jsonb(NEW) - 'lifecycle' IS DISTINCT FROM to_jsonb(OLD) - 'lifecycle' THEN
    RAISE EXCEPTION '% content is immutable once inserted', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_service_candidate_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_jsonb(NEW) - ARRAY['decision', 'decided_by_actor_id', 'decision_reason', 'decided_at']
    IS DISTINCT FROM
    to_jsonb(OLD) - ARRAY['decision', 'decided_by_actor_id', 'decision_reason', 'decided_at'] THEN
    RAISE EXCEPTION 'service candidate proposal fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_current_decision_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_jsonb(NEW) - 'current_decision_id'
    IS DISTINCT FROM
    to_jsonb(OLD) - 'current_decision_id' THEN
    RAISE EXCEPTION '% proposal fields are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  name text NOT NULL,
  kind organization_kind NOT NULL,
  parent_id uuid REFERENCES organizations (id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_parent_idx ON organizations (parent_id);

CREATE TABLE actors (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  kind actor_kind NOT NULL,
  display_name text NOT NULL,
  email text,
  organization_id uuid REFERENCES organizations (id),
  capabilities text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actors_organization_idx ON actors (organization_id);

CREATE TABLE visitors (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL UNIQUE REFERENCES actors (id),
  last_meaningful_route text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wip (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES visitors (id),
  acting_view acting_view NOT NULL,
  page_key text NOT NULL,
  subject_key text NOT NULL,
  payload jsonb NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  saved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visitor_id, acting_view, page_key, subject_key)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES actors (id),
  visitor_id uuid REFERENCES visitors (id),
  acting_view acting_view,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  payload jsonb NOT NULL,
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_subject_created_idx
  ON audit_events (subject_type, subject_id, created_at);
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE service_offerings (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  offering_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  supersedes_id uuid REFERENCES service_offerings (id),
  lifecycle lifecycle_state NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  owner_organization_id uuid NOT NULL REFERENCES organizations (id),
  capabilities text[] NOT NULL,
  prerequisites text[] NOT NULL,
  review_date date NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offering_key, version)
);
CREATE UNIQUE INDEX service_offerings_one_active_key
  ON service_offerings (offering_key)
  WHERE lifecycle = 'active';
CREATE TRIGGER service_offerings_content_immutable
  BEFORE UPDATE ON service_offerings
  FOR EACH ROW EXECUTE FUNCTION protect_versioned_reference_content();
CREATE TRIGGER service_offerings_no_delete
  BEFORE DELETE ON service_offerings
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE drafts (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  visitor_id uuid REFERENCES visitors (id),
  requester_actor_id uuid NOT NULL REFERENCES actors (id),
  requesting_organization_id uuid NOT NULL REFERENCES organizations (id),
  raw_need text NOT NULL,
  structured_content jsonb NOT NULL,
  field_origins jsonb NOT NULL,
  state draft_state NOT NULL,
  current_step text NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CHECK (visitor_id IS NOT NULL OR fixture_key IS NOT NULL)
);
CREATE INDEX drafts_visitor_state_idx ON drafts (visitor_id, state);

CREATE TABLE model_calls (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  draft_id uuid NOT NULL REFERENCES drafts (id),
  visitor_id uuid REFERENCES visitors (id),
  purpose model_purpose NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  corpus_versions jsonb NOT NULL,
  status model_status NOT NULL,
  attempt_count smallint NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 2),
  reserved_cost_micros integer NOT NULL CHECK (reserved_cost_micros >= 0),
  actual_cost_micros integer CHECK (actual_cost_micros >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  validated_output jsonb,
  sanitized_error text,
  idempotency_key text NOT NULL UNIQUE,
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'reserved' AND completed_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'denied') AND completed_at IS NOT NULL)
  ),
  CHECK (status <> 'succeeded' OR validated_output IS NOT NULL),
  CHECK (status <> 'failed' OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0))
);
CREATE INDEX model_calls_quota_idx
  ON model_calls (visitor_id, created_at, status);

CREATE TABLE draft_turns (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  draft_id uuid NOT NULL REFERENCES drafts (id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  actor turn_actor NOT NULL,
  actor_id uuid REFERENCES actors (id),
  model_call_id uuid REFERENCES model_calls (id),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, ordinal),
  CHECK (
    (actor = 'customer' AND actor_id IS NOT NULL AND model_call_id IS NULL)
    OR (actor = 'assistant' AND actor_id IS NULL AND model_call_id IS NOT NULL)
  )
);
CREATE TRIGGER draft_turns_immutable
  BEFORE UPDATE OR DELETE ON draft_turns
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE service_candidates (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  draft_id uuid NOT NULL REFERENCES drafts (id),
  model_call_id uuid NOT NULL REFERENCES model_calls (id),
  offering_id uuid NOT NULL REFERENCES service_offerings (id),
  rank smallint NOT NULL CHECK (rank > 0),
  fit_band fit_band NOT NULL,
  coverage text[] NOT NULL,
  gaps text[] NOT NULL,
  related_offering_keys text[] NOT NULL,
  rationale text NOT NULL,
  decision candidate_decision,
  decided_by_actor_id uuid REFERENCES actors (id),
  decision_reason text,
  decided_at timestamptz,
  UNIQUE (draft_id, model_call_id, rank),
  UNIQUE (id, draft_id),
  CHECK (
    (decision IS NULL AND decided_by_actor_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND decided_by_actor_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (decision <> 'rejected' OR (decision_reason IS NOT NULL AND length(trim(decision_reason)) > 0))
);
CREATE TRIGGER service_candidates_proposal_immutable
  BEFORE UPDATE ON service_candidates
  FOR EACH ROW EXECUTE FUNCTION protect_service_candidate_proposal();
CREATE TRIGGER service_candidates_no_delete
  BEFORE DELETE ON service_candidates
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE requests (
  id uuid PRIMARY KEY,
  display_id text NOT NULL UNIQUE,
  fixture_key text UNIQUE,
  owner_visitor_id uuid REFERENCES visitors (id),
  requester_actor_id uuid NOT NULL REFERENCES actors (id),
  requesting_organization_id uuid NOT NULL REFERENCES organizations (id),
  source_draft_id uuid NOT NULL UNIQUE REFERENCES drafts (id),
  selected_service_candidate_id uuid,
  routing_state routing_state NOT NULL,
  title text NOT NULL,
  problem text NOT NULL,
  affected_people text NOT NULL,
  acceptance_criteria text[] NOT NULL,
  requirements text[] NOT NULL,
  constraints text[] NOT NULL,
  unknowns text[] NOT NULL,
  stage request_stage NOT NULL,
  coordinating_actor_id uuid REFERENCES actors (id),
  current_rice_score_id uuid,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  first_review_completed_at timestamptz,
  CHECK (owner_visitor_id IS NOT NULL OR fixture_key IS NOT NULL),
  CHECK (
    (routing_state = 'service_selected' AND selected_service_candidate_id IS NOT NULL)
    OR (routing_state = 'routing_requested' AND selected_service_candidate_id IS NULL)
  ),
  FOREIGN KEY (selected_service_candidate_id, source_draft_id)
    REFERENCES service_candidates (id, draft_id)
);
CREATE INDEX requests_queue_idx ON requests (stage, updated_at);
CREATE INDEX requests_owner_visitor_idx ON requests (owner_visitor_id);
CREATE INDEX requests_organization_idx ON requests (requesting_organization_id);
CREATE INDEX requests_coordinator_idx ON requests (coordinating_actor_id);

CREATE TABLE task_completions (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  request_id uuid NOT NULL REFERENCES requests (id),
  actor_id uuid NOT NULL REFERENCES actors (id),
  visitor_id uuid REFERENCES visitors (id),
  task_type task_type NOT NULL,
  acting_view acting_view NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  origin data_origin NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, task_type, request_id),
  CHECK (
    (task_type = 'requester_submission' AND acting_view = 'requester')
    OR (task_type = 'contributor_first_review' AND acting_view = 'contributor')
  ),
  CHECK (origin <> 'live' OR visitor_id IS NOT NULL)
);
CREATE TRIGGER task_completions_immutable
  BEFORE UPDATE OR DELETE ON task_completions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE inventory_sources (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  name text NOT NULL UNIQUE,
  adapter_kind text NOT NULL,
  owner_organization_id uuid NOT NULL REFERENCES organizations (id),
  expected_freshness_hours integer NOT NULL CHECK (expected_freshness_hours > 0),
  lifecycle lifecycle_state NOT NULL,
  last_successful_at timestamptz,
  last_failed_at timestamptz,
  current_sync_run_id uuid,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_sync_runs (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  source_id uuid NOT NULL REFERENCES inventory_sources (id),
  source_version text NOT NULL,
  status sync_status NOT NULL,
  record_count integer NOT NULL CHECK (record_count >= 0),
  content_hash text,
  sanitized_error text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (source_id, source_version),
  UNIQUE (id, source_id),
  CHECK (status <> 'failed' OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0))
);
ALTER TABLE inventory_sources
  ADD CONSTRAINT inventory_sources_current_run_fk
  FOREIGN KEY (current_sync_run_id, id)
  REFERENCES inventory_sync_runs (id, source_id);

CREATE TABLE inventory_source_records (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  run_id uuid NOT NULL REFERENCES inventory_sync_runs (id),
  source_id uuid NOT NULL REFERENCES inventory_sources (id),
  source_record_key text NOT NULL,
  state source_record_state NOT NULL,
  raw_payload jsonb NOT NULL,
  normalized_fields jsonb NOT NULL,
  content_hash text NOT NULL,
  prior_record_id uuid REFERENCES inventory_source_records (id),
  observed_at timestamptz NOT NULL,
  UNIQUE (run_id, source_record_key)
);
CREATE INDEX inventory_source_records_source_key_idx
  ON inventory_source_records (source_id, source_record_key, observed_at);
CREATE TRIGGER inventory_source_records_immutable
  BEFORE UPDATE OR DELETE ON inventory_source_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE catalog_items (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  item_key text NOT NULL UNIQUE,
  publication_state catalog_state NOT NULL,
  approval_status approval_status NOT NULL,
  item_type catalog_item_type NOT NULL,
  current_version integer NOT NULL CHECK (current_version > 0),
  name text NOT NULL,
  vendor text,
  description text NOT NULL,
  capabilities text[] NOT NULL,
  owner_organization_id uuid NOT NULL REFERENCES organizations (id),
  license_model text,
  data_classifications text[] NOT NULL,
  integrations text[] NOT NULL,
  review_date date NOT NULL,
  renewal_date date,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_items_matching_idx
  ON catalog_items (publication_state, approval_status, item_type);

CREATE TABLE inventory_aliases (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  source_id uuid REFERENCES inventory_sources (id),
  catalog_item_id uuid REFERENCES catalog_items (id),
  created_by_actor_id uuid NOT NULL REFERENCES actors (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (normalized_alias, source_id)
);

CREATE TABLE inventory_conflicts (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  catalog_item_id uuid REFERENCES catalog_items (id),
  state conflict_state NOT NULL,
  opened_by_run_id uuid NOT NULL REFERENCES inventory_sync_runs (id),
  reopened_by_run_id uuid REFERENCES inventory_sync_runs (id),
  current_evidence_version integer NOT NULL DEFAULT 1 CHECK (current_evidence_version > 0),
  current_resolution_version integer CHECK (current_resolution_version > 0),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_conflicts_state_idx
  ON inventory_conflicts (state, updated_at);

CREATE TABLE inventory_conflict_members (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  conflict_id uuid NOT NULL REFERENCES inventory_conflicts (id),
  evidence_version integer NOT NULL CHECK (evidence_version > 0),
  source_record_id uuid NOT NULL REFERENCES inventory_source_records (id),
  grouping_reason text NOT NULL,
  UNIQUE (conflict_id, evidence_version, source_record_id)
);

CREATE TABLE catalog_field_decisions (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items (id),
  canonical_version integer NOT NULL CHECK (canonical_version > 0),
  field_name text NOT NULL,
  value jsonb NOT NULL,
  source_record_id uuid REFERENCES inventory_source_records (id),
  decided_by_actor_id uuid NOT NULL REFERENCES actors (id),
  rationale text,
  supersedes_id uuid REFERENCES catalog_field_decisions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_item_id, canonical_version, field_name),
  CHECK (source_record_id IS NOT NULL OR (rationale IS NOT NULL AND length(trim(rationale)) > 0))
);
CREATE TRIGGER catalog_field_decisions_immutable
  BEFORE UPDATE OR DELETE ON catalog_field_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE catalog_item_sources (
  catalog_item_id uuid NOT NULL REFERENCES catalog_items (id),
  source_record_id uuid NOT NULL REFERENCES inventory_source_records (id),
  fixture_key text UNIQUE,
  PRIMARY KEY (catalog_item_id, source_record_id)
);

CREATE TABLE review_tasks (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  request_id uuid NOT NULL REFERENCES requests (id),
  area review_area NOT NULL,
  responsible_capability text NOT NULL,
  assignee_actor_id uuid REFERENCES actors (id),
  state review_task_state NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (request_id, area)
);
CREATE INDEX review_tasks_assignee_state_idx
  ON review_tasks (assignee_actor_id, state);

CREATE TABLE asset_assessments (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  draft_id uuid NOT NULL REFERENCES drafts (id),
  model_call_id uuid REFERENCES model_calls (id),
  status assessment_status NOT NULL,
  catalog_corpus_hash text NOT NULL,
  sanitized_error text,
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'succeeded' AND sanitized_error IS NULL)
    OR (status = 'failed' AND sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)
  )
);
CREATE TRIGGER asset_assessments_immutable
  BEFORE UPDATE OR DELETE ON asset_assessments
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE asset_candidate_decisions (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  candidate_id uuid NOT NULL,
  decision candidate_decision NOT NULL,
  actor_id uuid NOT NULL REFERENCES actors (id),
  reason text,
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, candidate_id),
  CHECK (decision <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);

CREATE TABLE asset_candidates (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  assessment_id uuid NOT NULL REFERENCES asset_assessments (id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items (id),
  catalog_version integer NOT NULL CHECK (catalog_version > 0),
  rank smallint NOT NULL CHECK (rank > 0),
  fit_band fit_band NOT NULL,
  coverage text[] NOT NULL,
  gaps text[] NOT NULL,
  dependencies text[] NOT NULL,
  rationale text NOT NULL,
  current_decision_id uuid,
  UNIQUE (assessment_id, rank),
  UNIQUE (id, assessment_id),
  FOREIGN KEY (current_decision_id, id)
    REFERENCES asset_candidate_decisions (id, candidate_id)
);
CREATE TRIGGER asset_candidates_proposal_immutable
  BEFORE UPDATE ON asset_candidates
  FOR EACH ROW EXECUTE FUNCTION protect_current_decision_pointer();
CREATE TRIGGER asset_candidates_no_delete
  BEFORE DELETE ON asset_candidates
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
ALTER TABLE asset_candidate_decisions
  ADD CONSTRAINT asset_candidate_decisions_candidate_fk
  FOREIGN KEY (candidate_id) REFERENCES asset_candidates (id);
CREATE TRIGGER asset_candidate_decisions_immutable
  BEFORE UPDATE OR DELETE ON asset_candidate_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE policy_rules (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  supersedes_id uuid REFERENCES policy_rules (id),
  lifecycle lifecycle_state NOT NULL,
  domain risk_domain NOT NULL,
  title text NOT NULL,
  rule text NOT NULL,
  trigger_terms text[] NOT NULL,
  default_severity risk_severity NOT NULL,
  citation text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX policy_rules_one_active_code
  ON policy_rules (code)
  WHERE lifecycle = 'active';
CREATE INDEX policy_rules_domain_idx ON policy_rules (domain);
CREATE TRIGGER policy_rules_content_immutable
  BEFORE UPDATE ON policy_rules
  FOR EACH ROW EXECUTE FUNCTION protect_versioned_reference_content();
CREATE TRIGGER policy_rules_no_delete
  BEFORE DELETE ON policy_rules
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE risk_assessments (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  draft_id uuid NOT NULL REFERENCES drafts (id),
  model_call_id uuid REFERENCES model_calls (id),
  status assessment_status NOT NULL,
  policy_corpus_hash text NOT NULL,
  sanitized_error text,
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'succeeded' AND sanitized_error IS NULL)
    OR (status = 'failed' AND sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)
  )
);
CREATE TRIGGER risk_assessments_immutable
  BEFORE UPDATE OR DELETE ON risk_assessments
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE risk_finding_decisions (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  finding_id uuid NOT NULL,
  decision risk_decision NOT NULL,
  final_severity risk_severity,
  actor_id uuid NOT NULL REFERENCES actors (id),
  rationale text,
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, finding_id),
  CHECK (
    decision NOT IN ('overridden', 'follow_up_required')
    OR (rationale IS NOT NULL AND length(trim(rationale)) > 0)
  ),
  CHECK (decision <> 'overridden' OR final_severity IS NOT NULL)
);

CREATE TABLE risk_findings (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  assessment_id uuid NOT NULL REFERENCES risk_assessments (id),
  policy_rule_id uuid NOT NULL REFERENCES policy_rules (id),
  kind risk_kind NOT NULL,
  evidence text,
  missing_information text,
  proposed_severity risk_severity,
  rationale text NOT NULL,
  current_decision_id uuid,
  UNIQUE (id, assessment_id),
  CHECK (
    (
      kind = 'supported_risk'
      AND evidence IS NOT NULL
      AND proposed_severity IS NOT NULL
      AND missing_information IS NULL
    )
    OR (
      kind = 'missing_information'
      AND evidence IS NULL
      AND proposed_severity IS NULL
      AND missing_information IS NOT NULL
      AND length(trim(missing_information)) > 0
    )
  ),
  FOREIGN KEY (current_decision_id, id)
    REFERENCES risk_finding_decisions (id, finding_id)
);
CREATE TRIGGER risk_findings_proposal_immutable
  BEFORE UPDATE ON risk_findings
  FOR EACH ROW EXECUTE FUNCTION protect_current_decision_pointer();
CREATE TRIGGER risk_findings_no_delete
  BEFORE DELETE ON risk_findings
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
ALTER TABLE risk_finding_decisions
  ADD CONSTRAINT risk_finding_decisions_finding_fk
  FOREIGN KEY (finding_id) REFERENCES risk_findings (id);
CREATE TRIGGER risk_finding_decisions_immutable
  BEFORE UPDATE OR DELETE ON risk_finding_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE TABLE rice_scores (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  request_id uuid NOT NULL REFERENCES requests (id),
  version integer NOT NULL CHECK (version > 0),
  reach numeric(14, 2) NOT NULL CHECK (reach >= 0),
  reach_unit text NOT NULL CHECK (length(trim(reach_unit)) > 0),
  reach_period text NOT NULL CHECK (length(trim(reach_period)) > 0),
  reach_rationale text NOT NULL,
  reach_actor_id uuid NOT NULL REFERENCES actors (id),
  impact numeric(6, 2) NOT NULL CHECK (impact > 0),
  impact_rationale text NOT NULL,
  impact_actor_id uuid NOT NULL REFERENCES actors (id),
  confidence numeric(5, 4) NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  confidence_rationale text NOT NULL,
  confidence_actor_id uuid NOT NULL REFERENCES actors (id),
  effort numeric(10, 2) NOT NULL CHECK (effort > 0),
  effort_rationale text NOT NULL,
  effort_actor_id uuid NOT NULL REFERENCES actors (id),
  score numeric(16, 4) NOT NULL,
  rubric_version text NOT NULL,
  formula_version text NOT NULL,
  created_by_actor_id uuid NOT NULL REFERENCES actors (id),
  origin data_origin NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, version),
  UNIQUE (id, request_id),
  CHECK (
    formula_version <> 'rice-v1'
    OR abs(score - ((reach * impact * confidence) / effort)) < 0.0001
  )
);
CREATE TRIGGER rice_scores_immutable
  BEFORE UPDATE OR DELETE ON rice_scores
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
ALTER TABLE requests
  ADD CONSTRAINT requests_current_rice_score_fk
  FOREIGN KEY (current_rice_score_id, id)
  REFERENCES rice_scores (id, request_id);

CREATE TABLE work_systems (
  system external_system PRIMARY KEY,
  fixture_key text UNIQUE,
  name text NOT NULL,
  authoritative_base_url text NOT NULL,
  expected_freshness_hours integer NOT NULL CHECK (expected_freshness_hours > 0),
  last_successful_at timestamptz,
  sync_health sync_health NOT NULL
);

CREATE TABLE work_sync_runs (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  system external_system NOT NULL REFERENCES work_systems (system),
  status sync_status NOT NULL,
  item_count integer NOT NULL CHECK (item_count >= 0),
  sanitized_error text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (status <> 'failed' OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0))
);

CREATE TABLE external_work_items (
  id uuid PRIMARY KEY,
  fixture_key text UNIQUE,
  system external_system NOT NULL REFERENCES work_systems (system),
  external_id text NOT NULL,
  title text NOT NULL,
  source_status text NOT NULL,
  source_owner text,
  source_url text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  last_synchronized_at timestamptz NOT NULL,
  sync_health sync_health NOT NULL,
  UNIQUE (system, external_id)
);
CREATE INDEX external_work_items_health_idx
  ON external_work_items (system, sync_health, source_updated_at);

CREATE TABLE request_work_item_links (
  request_id uuid NOT NULL REFERENCES requests (id),
  work_item_id uuid NOT NULL REFERENCES external_work_items (id),
  relationship text NOT NULL,
  fixture_key text UNIQUE,
  PRIMARY KEY (request_id, work_item_id)
);
