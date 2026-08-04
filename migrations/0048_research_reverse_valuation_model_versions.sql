-- Reverse DCF is a distinct, immutable answer to what an explicitly stated
-- market-security price implies.  It never stores fetched/guessed market data.
create table research_reverse_valuation_model_versions (
  model_version_id text primary key,
  company_id text,
  security_code text not null,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  algorithm_version text not null,
  valuation_currency text not null,
  amount_scale text not null,
  security_currency text not null,
  price_per_security real not null,
  price_as_of integer not null,
  price_source_refs_json text not null,
  diluted_underlying_shares real not null,
  diluted_shares_source_refs_json text not null,
  underlying_shares_per_security real not null,
  net_debt_at_valuation real not null,
  net_debt_source_refs_json text not null,
  fx_rate_to_valuation real,
  fx_as_of integer,
  fx_source_refs_json text not null default '[]',
  wacc real not null,
  terminal_growth real not null,
  terminal_ufcf_margin real,
  terminal_ebit_margin real,
  assumption_source_refs_json text not null default '[]',
  outputs_json text not null,
  source_refs_json text not null default '[]',
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_reverse_valuation_model_versions_security
  on research_reverse_valuation_model_versions(security_code, as_of desc, created_at desc);
