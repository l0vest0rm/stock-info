-- 0064 was first exercised locally before peer_member_key was included in its
-- input identity. Rebuild the two linked child tables so both that early
-- schema and a fresh corrected 0064 converge on the same contract. Metric
-- rows are copied unchanged, then their foreign keys are rebound to the new
-- input table. No ledger, input or metric record is updated in place.

drop trigger if exists research_relative_valuation_inputs_immutable_update;
drop trigger if exists research_relative_valuation_inputs_immutable_delete;
drop trigger if exists research_relative_valuation_metrics_immutable_update;
drop trigger if exists research_relative_valuation_metrics_immutable_delete;
drop index if exists idx_research_relative_valuation_inputs_ledger;
drop index if exists idx_research_relative_valuation_metrics_ledger;

alter table research_relative_valuation_metrics rename to research_relative_valuation_metrics_legacy_0065;
alter table research_relative_valuation_inputs rename to research_relative_valuation_inputs_legacy_0065;

create table research_relative_valuation_inputs (
  relative_valuation_input_id text primary key,
  relative_valuation_ledger_id text not null,
  subject_kind text not null check (subject_kind in ('target', 'peer')),
  peer_member_id text,
  peer_member_key text not null default '',
  input_kind text not null check (input_kind in ('source_fact', 'forward_input', 'assumption')),
  input_key text not null,
  label text not null,
  value real not null,
  unit text not null,
  currency text,
  amount_scale text,
  fiscal_year integer,
  period_label text,
  input_as_of integer not null,
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'third_party_forecast', 'analysis_assumption')),
  source_refs_json text not null,
  unique(relative_valuation_ledger_id, subject_kind, peer_member_key, input_key),
  check ((subject_kind = 'target' and peer_member_id is null and peer_member_key = '') or (subject_kind = 'peer' and peer_member_id is not null and peer_member_key <> '')),
  foreign key(relative_valuation_ledger_id) references research_relative_valuation_ledgers(relative_valuation_ledger_id) on delete restrict
);
insert into research_relative_valuation_inputs (
  relative_valuation_input_id, relative_valuation_ledger_id, subject_kind, peer_member_id, peer_member_key, input_kind,
  input_key, label, value, unit, currency, amount_scale, fiscal_year, period_label, input_as_of, epistemic_type, source_refs_json
) select
  relative_valuation_input_id, relative_valuation_ledger_id, subject_kind, peer_member_id, coalesce(peer_member_id, ''), input_kind,
  input_key, label, value, unit, currency, amount_scale, fiscal_year, period_label, input_as_of, epistemic_type, source_refs_json
from research_relative_valuation_inputs_legacy_0065;

create table research_relative_valuation_metrics (
  relative_valuation_metric_id text primary key,
  relative_valuation_ledger_id text not null,
  subject_kind text not null check (subject_kind in ('target', 'peer')),
  peer_member_id text,
  metric_type text not null check (metric_type in ('pe', 'ev_ebitda', 'ev_revenue', 'pb', 'fcf_yield', 'dividend_yield', 'nav', 'other')),
  period_basis text not null check (period_basis in ('trailing', 'forward', 'normalized', 'other')),
  fiscal_year integer,
  definition text not null,
  numerator_input_id text not null,
  denominator_input_id text not null,
  display_unit text not null,
  unique(relative_valuation_ledger_id, relative_valuation_metric_id),
  check ((subject_kind = 'target' and peer_member_id is null) or (subject_kind = 'peer' and peer_member_id is not null)),
  foreign key(relative_valuation_ledger_id) references research_relative_valuation_ledgers(relative_valuation_ledger_id) on delete restrict,
  foreign key(numerator_input_id) references research_relative_valuation_inputs(relative_valuation_input_id) on delete restrict,
  foreign key(denominator_input_id) references research_relative_valuation_inputs(relative_valuation_input_id) on delete restrict
);
insert into research_relative_valuation_metrics (
  relative_valuation_metric_id, relative_valuation_ledger_id, subject_kind, peer_member_id, metric_type, period_basis,
  fiscal_year, definition, numerator_input_id, denominator_input_id, display_unit
) select
  relative_valuation_metric_id, relative_valuation_ledger_id, subject_kind, peer_member_id, metric_type, period_basis,
  fiscal_year, definition, numerator_input_id, denominator_input_id, display_unit
from research_relative_valuation_metrics_legacy_0065;

drop table research_relative_valuation_metrics_legacy_0065;
drop table research_relative_valuation_inputs_legacy_0065;

create index idx_research_relative_valuation_inputs_ledger
  on research_relative_valuation_inputs(relative_valuation_ledger_id, subject_kind, peer_member_key, input_key);
create index idx_research_relative_valuation_metrics_ledger
  on research_relative_valuation_metrics(relative_valuation_ledger_id, subject_kind, peer_member_id, metric_type);

create trigger research_relative_valuation_inputs_immutable_update
before update on research_relative_valuation_inputs begin
  select raise(abort, 'research relative valuation inputs are immutable');
end;
create trigger research_relative_valuation_inputs_immutable_delete
before delete on research_relative_valuation_inputs begin
  select raise(abort, 'research relative valuation inputs are immutable');
end;
create trigger research_relative_valuation_metrics_immutable_update
before update on research_relative_valuation_metrics begin
  select raise(abort, 'research relative valuation metrics are immutable');
end;
create trigger research_relative_valuation_metrics_immutable_delete
before delete on research_relative_valuation_metrics begin
  select raise(abort, 'research relative valuation metrics are immutable');
end;
