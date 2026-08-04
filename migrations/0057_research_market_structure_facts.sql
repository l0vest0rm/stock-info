-- Security-market facts are intentionally separate from operating-company
-- research and from the existing qualitative security-rights profile.  They
-- are append-only, source-bound observations; a later disclosure must never
-- overwrite the facts used by an existing valuation model.
create table research_market_structure_facts (
  market_structure_fact_id text primary key,
  security_code text not null,
  fact_key text not null,
  fact_status text not null check (fact_status in ('verified', 'unavailable', 'not_applicable', 'conflicting')),
  value_kind text not null check (value_kind in ('number', 'text')),
  value_number real,
  value_text text,
  unit text,
  as_of text not null,
  frequency text not null check (frequency in ('event', 'annual', 'quarterly', 'periodic', 'rule_change')),
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'source_viewpoint')),
  source_authority text not null check (source_authority in ('issuer_disclosure', 'exchange_rule', 'regulator_filing', 'depositary_agreement', 'tax_authority_rule', 'broker_rule')),
  source_url text not null,
  source_title text not null,
  source_note text not null,
  effective_from text,
  effective_to text,
  created_at integer not null,
  check ((fact_status = 'verified' and ((value_kind = 'number' and value_number is not null and unit is not null) or (value_kind = 'text' and value_text is not null))) or fact_status <> 'verified'),
  check ((value_kind = 'number' and value_text is null) or (value_kind = 'text' and value_number is null)),
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create unique index idx_research_market_structure_fact_version
  on research_market_structure_facts(security_code, fact_key, as_of, source_url);
create index idx_research_market_structure_fact_current
  on research_market_structure_facts(security_code, fact_key, as_of desc, created_at desc);
