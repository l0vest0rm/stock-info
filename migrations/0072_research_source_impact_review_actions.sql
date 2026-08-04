-- An explicit source-to-target mapping is only the start of review.  This
-- append-only action ledger records the human disposition for public thesis
-- and risk targets, without ever editing the thesis/risk record itself.

alter table research_guidance_event_impact_review_targets rename to research_guidance_event_impact_review_targets_v1;

create table research_guidance_event_impact_review_targets (
  impact_review_target_id text primary key,
  impact_review_id text not null,
  target_kind text not null check (target_kind in ('thesis', 'risk', 'scenario', 'dcf', 'reverse_dcf')),
  target_id text not null,
  review_state text not null check (review_state in ('requires_review', 'no_change', 'follow_up_recorded', 'not_applicable')),
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
  on research_guidance_event_impact_review_targets(impact_review_id, review_state, target_kind, target_id);

create table research_guidance_event_impact_review_target_actions (
  action_id text primary key,
  impact_review_target_id text not null unique,
  previous_state text not null check (previous_state = 'requires_review'),
  decision text not null check (decision in ('no_change', 'follow_up_recorded', 'not_applicable')),
  rationale text not null,
  acted_by text not null,
  follow_up_target_id text,
  acted_at integer not null,
  foreign key(impact_review_target_id) references research_guidance_event_impact_review_targets(impact_review_target_id) on delete restrict,
  check ((decision = 'follow_up_recorded' and follow_up_target_id is not null)
    or (decision <> 'follow_up_recorded' and follow_up_target_id is null))
);
create index idx_research_guidance_event_impact_review_target_actions_target
  on research_guidance_event_impact_review_target_actions(impact_review_target_id, acted_at desc);
