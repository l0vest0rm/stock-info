-- Immutable local audit trail for S0 routing confirmation.  The controlled
-- industry-template registry lives in config and is validated by the API;
-- this table records the selected ID and the evidence/scope presented to the
-- operator without making the registry a mutable database fallback.
create table if not exists research_operating_analysis_routing_confirmations (
  confirmation_id text primary key,
  security_code text not null,
  company_id text,
  actor_key text not null,
  routing_state_before text not null check (routing_state_before in ('unconfirmed', 'confirmed')),
  routing_state_after text not null check (routing_state_after = 'confirmed'),
  selected_template_id text not null,
  scope_note text,
  company_scope_json text not null default '{}',
  candidate_templates_json text not null default '[]',
  source_artifact_id text,
  created_at integer not null
);

create index if not exists idx_research_operating_analysis_routing_code
  on research_operating_analysis_routing_confirmations (security_code, created_at desc, confirmation_id desc);
