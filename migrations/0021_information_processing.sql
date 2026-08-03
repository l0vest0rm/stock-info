-- Information processing. knowledge_docs remains the import/source entry;
-- this ledger is append-only so a later extraction never destroys prior evidence.
create table if not exists knowledge_document_versions (
  version_id text primary key,
  doc_id text not null,
  source_url text,
  source_hash text,
  content_hash text not null,
  raw_content_key text,
  normalized_content_key text,
  structure_json text not null default '{}',
  published_at text,
  fetched_at text,
  access_policy_json text not null default '{}',
  created_at integer not null,
  unique(doc_id, content_hash),
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict
);
create index if not exists idx_knowledge_document_versions_doc on knowledge_document_versions(doc_id, created_at desc);
create index if not exists idx_knowledge_document_versions_hash on knowledge_document_versions(content_hash);

create table if not exists knowledge_preprocessing_decisions (
  decision_id text primary key,
  version_id text not null,
  action text not null check (action in ('pass','exact_duplicate','template_duplicate','pure_market_snapshot','empty_content','fetch_error')),
  reason_code text not null,
  rule_version text not null,
  matched_source_type text,
  matched_template_id text,
  duplicate_of_version_id text,
  details_json text not null default '{}',
  decided_at integer not null,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict,
  foreign key(duplicate_of_version_id) references knowledge_document_versions(version_id) on delete restrict
);
create index if not exists idx_knowledge_preprocessing_version on knowledge_preprocessing_decisions(version_id, decided_at desc);

create table if not exists knowledge_processing_runs (
  run_id text primary key,
  version_id text not null,
  stage text not null check (stage in ('document_analysis','long_document_chunk','long_document_merge','claim_reconcile','entity_view','targeted_review')),
  model text not null,
  returned_model text,
  prompt_version text not null,
  schema_version text not null,
  ontology_version text not null,
  input_hash text not null,
  raw_output_key text,
  status text not null check (status in ('queued','running','succeeded','failed','needs_review','skipped')),
  usage_json text not null default '{}',
  validation_json text not null default '{}',
  retry_count integer not null default 0,
  error text,
  started_at integer not null,
  completed_at integer,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict
);
create index if not exists idx_knowledge_processing_runs_version on knowledge_processing_runs(version_id, started_at desc);
create index if not exists idx_knowledge_processing_runs_status on knowledge_processing_runs(status, started_at desc);

create table if not exists knowledge_document_results (
  result_id text primary key,
  run_id text not null unique,
  version_id text not null,
  retention_action text not null check (retention_action in ('retain_structured','retain_summary_only','discard_low_value','needs_review')),
  value_level text,
  reason_codes_json text not null default '[]',
  document_type text,
  scope text,
  primary_subjects_json text not null default '[]',
  mentions_json text not null default '[]',
  summary text,
  key_assertion_refs_json text not null default '[]',
  reconciliation_hints_json text not null default '[]',
  quality_json text not null default '{}',
  created_at integer not null,
  foreign key(run_id) references knowledge_processing_runs(run_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict
);
create index if not exists idx_knowledge_document_results_version on knowledge_document_results(version_id, created_at desc);

create table if not exists knowledge_entities (
  entity_id text primary key,
  entity_type text not null check (entity_type in ('company','industry','product','model','technology','customer','region','topic')),
  canonical_name text not null,
  external_code text,
  metadata_json text not null default '{}',
  created_at integer not null,
  updated_at integer not null,
  unique(entity_type, canonical_name)
);
create index if not exists idx_knowledge_entities_type_code on knowledge_entities(entity_type, external_code);
create table if not exists knowledge_entity_aliases (
  entity_id text not null,
  alias text not null,
  source text not null,
  created_at integer not null,
  primary key(entity_id, alias),
  foreign key(entity_id) references knowledge_entities(entity_id) on delete restrict
);
create index if not exists idx_knowledge_entity_aliases_alias on knowledge_entity_aliases(alias);

create table if not exists knowledge_evidence_spans (
  span_id text primary key,
  version_id text not null,
  chunk_id text,
  page_number integer,
  section_path text,
  position_json text not null default '{}',
  exact_quote text not null,
  content_hash text not null,
  created_at integer not null,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict
);
create index if not exists idx_knowledge_evidence_spans_version on knowledge_evidence_spans(version_id);

create table if not exists knowledge_assertions (
  assertion_id text primary key,
  run_id text not null,
  assertion_type text not null check (assertion_type in ('reported_actual','management_guidance','third_party_forecast','opinion','event','relationship')),
  subject_entity_id text,
  subject_name text not null,
  predicate_id text,
  value_json text not null default '{}',
  dimensions_json text not null default '{}',
  period_json text not null default '{}',
  modality text,
  speaker text,
  qualifiers_json text not null default '[]',
  extraction_confidence real,
  uncertainties_json text not null default '[]',
  status text not null default 'active' check (status in ('active','needs_review','invalid')),
  created_at integer not null,
  foreign key(run_id) references knowledge_processing_runs(run_id) on delete restrict,
  foreign key(subject_entity_id) references knowledge_entities(entity_id) on delete restrict
);
create index if not exists idx_knowledge_assertions_subject on knowledge_assertions(subject_entity_id, predicate_id, created_at desc);
create table if not exists knowledge_assertion_evidence (
  assertion_id text not null,
  span_id text not null,
  role text not null default 'supports' check (role in ('supports','qualifies','contradicts')),
  primary key(assertion_id, span_id),
  foreign key(assertion_id) references knowledge_assertions(assertion_id) on delete restrict,
  foreign key(span_id) references knowledge_evidence_spans(span_id) on delete restrict
);

create table if not exists knowledge_claims (
  claim_id text primary key,
  subject_entity_id text not null,
  predicate_id text,
  scope_json text not null default '{}',
  period_json text not null default '{}',
  current_state text not null default 'active' check (current_state in ('active','superseded','corrected','retracted','resolved','needs_review')),
  first_known_at integer not null,
  last_changed_at integer not null,
  created_at integer not null,
  foreign key(subject_entity_id) references knowledge_entities(entity_id) on delete restrict
);
create index if not exists idx_knowledge_claims_subject on knowledge_claims(subject_entity_id, predicate_id, current_state);
create table if not exists knowledge_claim_assertions (
  claim_id text not null,
  assertion_id text not null,
  relation text not null check (relation in ('new','supports','supplements','revises','contradicts','corrects','retracts','resolves')),
  reconciliation_run_id text,
  rationale_json text not null default '{}',
  needs_review integer not null default 0 check (needs_review in (0,1)),
  created_at integer not null,
  primary key(claim_id, assertion_id),
  foreign key(claim_id) references knowledge_claims(claim_id) on delete restrict,
  foreign key(assertion_id) references knowledge_assertions(assertion_id) on delete restrict,
  foreign key(reconciliation_run_id) references knowledge_processing_runs(run_id) on delete restrict
);
create table if not exists knowledge_claim_state_history (
  history_id text primary key,
  claim_id text not null,
  previous_state text,
  next_state text not null,
  decision_run_id text,
  rationale_json text not null default '{}',
  effective_at integer not null,
  recorded_at integer not null,
  foreign key(claim_id) references knowledge_claims(claim_id) on delete restrict,
  foreign key(decision_run_id) references knowledge_processing_runs(run_id) on delete restrict
);
create index if not exists idx_knowledge_claim_history_claim on knowledge_claim_state_history(claim_id, effective_at desc);

create table if not exists knowledge_entity_views (
  view_id text primary key,
  entity_id text not null,
  entity_type text not null,
  as_of integer not null,
  previous_view_id text,
  model text not null,
  prompt_version text not null,
  summary_json text not null default '{}',
  change_summary_json text not null default '{}',
  created_at integer not null,
  foreign key(entity_id) references knowledge_entities(entity_id) on delete restrict,
  foreign key(previous_view_id) references knowledge_entity_views(view_id) on delete restrict
);
create index if not exists idx_knowledge_entity_views_lookup on knowledge_entity_views(entity_id, as_of desc);
create table if not exists knowledge_view_items (
  view_id text not null,
  item_id text not null,
  section text not null,
  content_json text not null,
  sort_order integer not null,
  primary key(view_id, item_id),
  foreign key(view_id) references knowledge_entity_views(view_id) on delete restrict
);
create table if not exists knowledge_view_item_claims (
  view_id text not null,
  item_id text not null,
  claim_id text not null,
  primary key(view_id, item_id, claim_id),
  foreign key(view_id, item_id) references knowledge_view_items(view_id, item_id) on delete restrict,
  foreign key(claim_id) references knowledge_claims(claim_id) on delete restrict
);
