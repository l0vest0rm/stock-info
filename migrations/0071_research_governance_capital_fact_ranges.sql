-- A public filing can disclose a binding interval (for example a proposed
-- repurchase floor and ceiling). Preserve both endpoints; do not silently
-- replace it with a midpoint, a maximum, or an execution amount.
alter table research_governance_capital_fact_versions rename to research_governance_capital_fact_versions_v1;

create table research_governance_capital_fact_versions (
  governance_capital_fact_version_id text primary key,
  candidate_review_id text not null unique,
  supersedes_fact_version_id text,
  company_id text not null,
  security_code text not null,
  fact_key text not null,
  fact_status text not null check (fact_status in ('verified', 'unavailable', 'conflicting')),
  value_kind text not null check (value_kind in ('number', 'text')),
  value_number real,
  value_range_lower real,
  value_range_upper real,
  value_text text,
  unit text,
  as_of text not null,
  period text,
  source_authority text not null check (source_authority in ('issuer_disclosure', 'exchange_filing', 'regulator_or_court', 'audit_report')),
  information_id text not null,
  result_id text not null,
  run_id text not null,
  version_id text not null,
  content_hash text not null,
  doc_id text not null,
  source_url text,
  content_url text,
  source_title text,
  source_name text,
  published_at text,
  source_locator text not null,
  created_at integer not null,
  check ((value_kind = 'number' and value_text is null and (
      (value_number is null and value_range_lower is null and value_range_upper is null)
      or (value_number is not null and value_range_lower is null and value_range_upper is null)
      or (value_number is null and value_range_lower is not null and value_range_upper is not null and value_range_lower <= value_range_upper)
    )) or (value_kind = 'text' and value_number is null and value_range_lower is null and value_range_upper is null)),
  check ((fact_status = 'verified' and ((value_kind = 'number' and unit is not null and (value_number is not null or (value_range_lower is not null and value_range_upper is not null))) or (value_kind = 'text' and value_text is not null))) or fact_status <> 'verified'),
  foreign key(candidate_review_id) references research_governance_capital_fact_candidate_reviews(candidate_review_id) on delete restrict,
  foreign key(supersedes_fact_version_id) references research_governance_capital_fact_versions(governance_capital_fact_version_id) on delete restrict,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);

insert into research_governance_capital_fact_versions (
  governance_capital_fact_version_id, candidate_review_id, supersedes_fact_version_id, company_id, security_code, fact_key, fact_status,
  value_kind, value_number, value_range_lower, value_range_upper, value_text, unit, as_of, period, source_authority, information_id, result_id, run_id, version_id,
  content_hash, doc_id, source_url, content_url, source_title, source_name, published_at, source_locator, created_at
)
select governance_capital_fact_version_id, candidate_review_id, supersedes_fact_version_id, company_id, security_code, fact_key, fact_status,
  value_kind, value_number, null, null, value_text, unit, as_of, period, source_authority, information_id, result_id, run_id, version_id,
  content_hash, doc_id, source_url, content_url, source_title, source_name, published_at, source_locator, created_at
from research_governance_capital_fact_versions_v1;

drop table research_governance_capital_fact_versions_v1;
create index idx_research_governance_capital_facts_company_current on research_governance_capital_fact_versions(company_id, fact_key, as_of desc, created_at desc);
create index idx_research_governance_capital_facts_security on research_governance_capital_fact_versions(security_code, created_at desc);
