-- The candidate is a frozen interpretation of a statutory verification.  Keep
-- its dictionary identity in a normalized immutable binding so a later
-- dictionary change cannot silently alter what an older candidate meant.
-- It intentionally avoids ALTERing 0051's evidence table: that keeps this
-- migration safe for a rolling local runtime as well as a fresh database.
create table research_formal_actual_candidate_dictionary_bindings (
  candidate_id text primary key,
  fact_dictionary_entry_id text not null,
  fact_dictionary_version text not null,
  bound_at integer not null,
  foreign key(candidate_id) references research_formal_actual_candidates(candidate_id) on delete restrict
);

-- 0051 candidates were already deterministically mapped for these two
-- entries.  Backfill only dictionary metadata; never change their evidence,
-- value, eligibility, review, or actual link.
insert or ignore into research_formal_actual_candidate_dictionary_bindings (
  candidate_id, fact_dictionary_entry_id, fact_dictionary_version, bound_at
)
select candidate_id,
  case metric
    when 'revenue' then 'formal-financial-fact:revenue'
    when 'operating_cash_flow' then 'formal-financial-fact:operating-cash-flow'
    when 'net_profit' then 'formal-financial-fact:net-profit'
  end,
  'formal-financial-fact-dictionary.v1', created_at
from research_formal_actual_candidates
where metric in ('revenue', 'net_profit', 'operating_cash_flow');

-- Net profit becomes safely eligible under the v2 dictionary only when the
-- immutable underlying verification itself is a complete statutory match.
-- Old candidates that were blocked solely because v1 had no dictionary entry
-- receive this deterministic re-materialization; conflict/unverified rows
-- remain blocked.  No reported value or source locator is changed.
update research_formal_actual_candidates
set forecast_metric = 'net_profit',
  candidate_rule_version = 'formal-actual-candidate.v2',
  eligibility = 'ready_for_review',
  blocking_reason = null
where metric = 'net_profit'
  and eligibility = 'blocked'
  and blocking_reason = 'metric_requires_explicit_dictionary_mapping'
  and exists (
    select 1 from research_financial_statutory_verifications v
    where v.verification_id = research_formal_actual_candidates.verification_id
      and v.outcome = 'match'
      and v.statutory_value is not null
      and v.statutory_currency is not null
      and v.statutory_document_id is not null
      and v.statutory_disclosure_url is not null
      and v.statutory_locator is not null
      and v.statutory_published_at is not null
  );

-- `research_model_review_items` is the current-state queue.  This table is
-- the append-only closure audit.  It records a human acknowledgement or
-- resolution without editing a historical DCF, reverse DCF, or scenario.
create table if not exists research_model_review_item_actions (
  action_id text primary key,
  review_item_id text not null unique,
  previous_state text not null check (previous_state = 'open'),
  next_state text not null check (next_state in ('acknowledged', 'resolved', 'not_applicable')),
  acted_by text not null,
  resolution_note text not null,
  follow_up_target_kind text check (follow_up_target_kind in ('dcf', 'reverse_dcf', 'scenario')),
  follow_up_target_version_id text,
  acted_at integer not null,
  foreign key(review_item_id) references research_model_review_items(review_item_id) on delete restrict,
  check ((follow_up_target_kind is null and follow_up_target_version_id is null)
    or (follow_up_target_kind is not null and follow_up_target_version_id is not null))
);
create index if not exists idx_research_model_review_item_actions_item
  on research_model_review_item_actions(review_item_id, acted_at desc);
