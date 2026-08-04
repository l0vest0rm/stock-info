-- Extends the append-only source-impact review ledger.  A formally accepted
-- filing fact can be explicitly linked to the exact thesis, risk, self-built
-- scenario, DCF or reverse-DCF version that a human wants to revisit.  These
-- links are review requests, never a change to the linked record.

alter table research_guidance_event_impact_reviews rename to research_guidance_event_impact_reviews_v1;

create table research_guidance_event_impact_reviews (
  impact_review_id text primary key,
  security_code text not null,
  company_id text,
  source_kind text not null check (source_kind in ('management_guidance', 'catalyst_actual', 'formal_actual')),
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

insert into research_guidance_event_impact_reviews (
  impact_review_id, security_code, company_id, source_kind, source_id, source_observed_at,
  reviewer, rationale, source_binding_json, created_at
)
select impact_review_id, security_code, company_id, source_kind, source_id, source_observed_at,
  reviewer, rationale, source_binding_json, created_at
from research_guidance_event_impact_reviews_v1;

drop table research_guidance_event_impact_reviews_v1;
create index idx_research_guidance_event_impact_reviews_security
  on research_guidance_event_impact_reviews(security_code, created_at desc);

alter table research_guidance_event_impact_review_targets rename to research_guidance_event_impact_review_targets_v1;

create table research_guidance_event_impact_review_targets (
  impact_review_target_id text primary key,
  impact_review_id text not null,
  target_kind text not null check (target_kind in ('thesis', 'risk', 'scenario', 'dcf', 'reverse_dcf')),
  target_id text not null,
  review_state text not null check (review_state = 'requires_review'),
  created_at integer not null,
  unique(impact_review_id, target_kind, target_id),
  foreign key(impact_review_id) references research_guidance_event_impact_reviews(impact_review_id) on delete restrict
);

insert into research_guidance_event_impact_review_targets (
  impact_review_target_id, impact_review_id, target_kind, target_id, review_state, created_at
)
select impact_review_target_id, impact_review_id, target_kind, target_id, review_state, created_at
from research_guidance_event_impact_review_targets_v1;

drop table research_guidance_event_impact_review_targets_v1;
create index idx_research_guidance_event_impact_review_targets_review
  on research_guidance_event_impact_review_targets(impact_review_id, target_kind, target_id);
