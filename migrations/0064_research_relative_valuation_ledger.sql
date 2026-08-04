-- Immutable, source-bound relative valuation records.  Each record describes
-- one listed security and one method; it never represents a recommendation or
-- a consensus estimate.  New evidence creates a new ledger row.
create table research_relative_valuation_ledgers (
  relative_valuation_ledger_id text primary key,
  company_id text,
  security_code text not null,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed')),
  valuation_role text not null check (valuation_role in ('primary', 'auxiliary')),
  valuation_archetype text not null check (valuation_archetype in (
    'growth_earnings', 'stable_cash_dividend', 'cyclical_commodity', 'bank',
    'insurer_broker', 'asset_utility', 'pre_profit_milestone', 'conglomerate_sotp', 'other'
  )),
  method text not null check (method in (
    'forward_pe', 'ev_ebitda', 'ev_revenue', 'pb_roe', 'pb', 'fcf_yield',
    'dividend_yield', 'nav', 'price_to_embedded_value', 'other'
  )),
  peer_universe_id text not null,
  valuation_currency text not null,
  security_currency text not null,
  applicability_rationale text not null,
  rationale_source_refs_json text not null,
  supersedes_ledger_id text,
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict,
  foreign key(supersedes_ledger_id) references research_relative_valuation_ledgers(relative_valuation_ledger_id) on delete restrict
);
create index idx_research_relative_valuation_ledgers_security
  on research_relative_valuation_ledgers(security_code, as_of desc, created_at desc);

-- Facts, forward inputs and analyst assumptions are stored separately so a
-- displayed multiple can be replayed without refreshing a quote or forecast.
create table research_relative_valuation_inputs (
  relative_valuation_input_id text primary key,
  relative_valuation_ledger_id text not null,
  subject_kind text not null check (subject_kind in ('target', 'peer')),
  peer_member_id text,
  -- Normalized empty key lets the uniqueness contract distinguish target
  -- inputs while allowing every peer to use the same semantic input key.
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
create index idx_research_relative_valuation_inputs_ledger
  on research_relative_valuation_inputs(relative_valuation_ledger_id, subject_kind, peer_member_key, input_key);

-- A metric is always a deterministic numerator / denominator ratio.  The two
-- referenced inputs retain the facts or assumptions used at the record's date.
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
create index idx_research_relative_valuation_metrics_ledger
  on research_relative_valuation_metrics(relative_valuation_ledger_id, subject_kind, peer_member_id, metric_type);

-- These six gates are required even for single-market comparisons.  They make
-- unresolved accounting, calendar, FX, business-cycle or security-rights
-- differences visible instead of allowing a peer average to imply precision.
create table research_relative_valuation_comparability_gates (
  relative_valuation_gate_id text primary key,
  relative_valuation_ledger_id text not null,
  gate_kind text not null check (gate_kind in ('accounting_basis', 'fiscal_period', 'currency', 'business_scope', 'cycle_position', 'security_rights')),
  status text not null check (status in ('passed', 'adjustment_required', 'blocked', 'not_assessed')),
  rationale text not null,
  source_refs_json text not null,
  unique(relative_valuation_ledger_id, gate_kind),
  foreign key(relative_valuation_ledger_id) references research_relative_valuation_ledgers(relative_valuation_ledger_id) on delete restrict
);

-- Ledger records are append-only.  A later record can point at the one it
-- replaces, but neither evidence nor a prior conclusion may be rewritten.
create trigger research_relative_valuation_ledgers_immutable_update
before update on research_relative_valuation_ledgers begin
  select raise(abort, 'research relative valuation ledgers are immutable');
end;
create trigger research_relative_valuation_ledgers_immutable_delete
before delete on research_relative_valuation_ledgers begin
  select raise(abort, 'research relative valuation ledgers are immutable');
end;
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
create trigger research_relative_valuation_comparability_gates_immutable_update
before update on research_relative_valuation_comparability_gates begin
  select raise(abort, 'research relative valuation gates are immutable');
end;
create trigger research_relative_valuation_comparability_gates_immutable_delete
before delete on research_relative_valuation_comparability_gates begin
  select raise(abort, 'research relative valuation gates are immutable');
end;
