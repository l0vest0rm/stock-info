-- Preserve the append-only market-structure ledger while adding a distinct
-- authority for binding regulatory rules/notices. A regulator rule is neither
-- a company filing nor a broker statement, so keeping it separate prevents
-- source-role drift in cross-market security comparisons.
create table research_market_structure_facts_next (
  market_structure_fact_id text primary key,
  security_code text not null,
  fact_key text not null,
  fact_status text not null check (fact_status in ('verified', 'unavailable', 'not_applicable', 'conflicting')),
  value_kind text not null check (value_kind in ('number', 'text')),
  value_number real,
  value_text text,
  unit text,
  measurement_basis text,
  as_of text not null,
  frequency text not null check (frequency in ('event', 'annual', 'quarterly', 'periodic', 'rule_change')),
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'source_viewpoint')),
  source_authority text not null check (source_authority in ('issuer_disclosure', 'exchange_rule', 'regulator_filing', 'regulator_rule', 'depositary_agreement', 'tax_authority_rule', 'broker_rule')),
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

insert into research_market_structure_facts_next (
  market_structure_fact_id, security_code, fact_key, fact_status, value_kind,
  value_number, value_text, unit, measurement_basis, as_of, frequency,
  epistemic_type, source_authority, source_url, source_title, source_note,
  effective_from, effective_to, created_at
)
select market_structure_fact_id, security_code, fact_key, fact_status, value_kind,
  value_number, value_text, unit, measurement_basis, as_of, frequency,
  epistemic_type, source_authority, source_url, source_title, source_note,
  effective_from, effective_to, created_at
from research_market_structure_facts;

drop table research_market_structure_facts;
alter table research_market_structure_facts_next rename to research_market_structure_facts;
create unique index idx_research_market_structure_fact_version
  on research_market_structure_facts(
    security_code,
    fact_key,
    as_of,
    source_url,
    coalesce(measurement_basis, '')
  );
create index idx_research_market_structure_fact_current
  on research_market_structure_facts(security_code, fact_key, as_of desc, created_at desc);

-- 0060 originally installed these guards on the old table. Rebuilding the
-- table drops its triggers, so recreate them here rather than weakening the
-- database-level distinction between period-end and EPS share denominators.
create trigger research_market_structure_measurement_basis_before_insert
before insert on research_market_structure_facts
begin
  select case when new.fact_key in ('basic_shares', 'diluted_shares')
    and (new.measurement_basis is null or new.measurement_basis not in ('period_end_outstanding', 'weighted_average_eps'))
    then raise(abort, 'share-count market structure facts require a valid measurement basis') end;
  select case when new.fact_key not in ('basic_shares', 'diluted_shares')
    and new.measurement_basis is not null
    then raise(abort, 'measurement basis is only allowed for share-count market structure facts') end;
end;

create trigger research_market_structure_measurement_basis_before_update
before update of fact_key, measurement_basis on research_market_structure_facts
begin
  select case when new.fact_key in ('basic_shares', 'diluted_shares')
    and (new.measurement_basis is null or new.measurement_basis not in ('period_end_outstanding', 'weighted_average_eps'))
    then raise(abort, 'share-count market structure facts require a valid measurement basis') end;
  select case when new.fact_key not in ('basic_shares', 'diluted_shares')
    and new.measurement_basis is not null
    then raise(abort, 'measurement basis is only allowed for share-count market structure facts') end;
end;
