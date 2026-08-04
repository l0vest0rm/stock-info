-- A source-bound management guidance or completed event review can require a
-- human re-check of existing theses, risks and frozen models.  This is an
-- append-only review queue: it never changes a thesis/risk status or model
-- inputs/results as a side effect.

drop index if exists idx_research_model_review_items_security;
alter table research_model_review_items rename to research_model_review_items_v1;

create table research_model_review_items (
  review_item_id text primary key,
  security_code text not null,
  trigger_kind text not null check (trigger_kind in (
    'formal_actual_accepted', 'actual_restatement', 'calibration_available', 'calibration_blocked',
    'management_guidance_reviewed', 'catalyst_actual_reviewed'
  )),
  trigger_id text not null,
  target_kind text not null check (target_kind in ('dcf', 'reverse_dcf', 'scenario')),
  target_version_id text not null,
  state text not null check (state in ('open', 'acknowledged', 'resolved', 'not_applicable')),
  reason text not null,
  evidence_json text not null default '{}',
  created_at integer not null,
  reviewed_at integer,
  resolution_note text,
  unique(trigger_kind, trigger_id, target_kind, target_version_id),
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);

insert into research_model_review_items (
  review_item_id, security_code, trigger_kind, trigger_id, target_kind, target_version_id,
  state, reason, evidence_json, created_at, reviewed_at, resolution_note
)
select review_item_id, security_code, trigger_kind, trigger_id, target_kind, target_version_id,
  state, reason, evidence_json, created_at, reviewed_at, resolution_note
from research_model_review_items_v1;

drop table research_model_review_items_v1;
create index idx_research_model_review_items_security
  on research_model_review_items(security_code, state, created_at desc);

create table research_guidance_event_impact_reviews (
  impact_review_id text primary key,
  security_code text not null,
  company_id text,
  source_kind text not null check (source_kind in ('management_guidance', 'catalyst_actual')),
  source_id text not null,
  source_observed_at text,
  reviewer text not null,
  rationale text not null,
  source_binding_json text not null,
  created_at integer not null,
  unique(security_code, source_kind, source_id, impact_review_id),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_guidance_event_impact_reviews_security
  on research_guidance_event_impact_reviews(security_code, created_at desc);

create table research_guidance_event_impact_review_targets (
  impact_review_target_id text primary key,
  impact_review_id text not null,
  target_kind text not null check (target_kind in ('thesis', 'risk')),
  target_id text not null,
  review_state text not null check (review_state = 'requires_review'),
  created_at integer not null,
  unique(impact_review_id, target_kind, target_id),
  foreign key(impact_review_id) references research_guidance_event_impact_reviews(impact_review_id) on delete restrict
);
create index idx_research_guidance_event_impact_review_targets_review
  on research_guidance_event_impact_review_targets(impact_review_id, target_kind, target_id);
