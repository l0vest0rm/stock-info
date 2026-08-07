-- Retain every structurally readable model fact.  Evidence-chain gaps become
-- explicit statuses instead of causing the complete fact to disappear.
create table research_web_search_evidence_records_next (
  evidence_id text primary key,
  package_id text not null,
  security_code text not null,
  tab_id text not null check (tab_id in ('business', 'market', 'financial', 'industry', 'forecast', 'risk')),
  field_key text not null,
  subject text not null,
  statement text not null,
  numeric_value real,
  unit text,
  currency text,
  period text,
  product_scope text,
  region_scope text,
  source_title text,
  source_url text,
  source_published_at text,
  evidence_quote text,
  evidence_locator text,
  status text not null check (status in ('verified', 'unavailable', 'uncited', 'citation_unquoted', 'format_incomplete')),
  created_at integer not null,
  foreign key(package_id) references research_web_search_source_packages(package_id) on delete cascade
);

insert into research_web_search_evidence_records_next (
  evidence_id, package_id, security_code, tab_id, field_key, subject, statement, numeric_value, unit, currency, period,
  product_scope, region_scope, source_title, source_url, source_published_at, evidence_quote, evidence_locator, status, created_at
)
select evidence_id, package_id, security_code, tab_id, field_key, subject, statement, numeric_value, unit, currency, period,
  product_scope, region_scope, source_title, source_url, source_published_at, evidence_quote, evidence_locator, status, created_at
from research_web_search_evidence_records;

drop table research_web_search_evidence_records;
alter table research_web_search_evidence_records_next rename to research_web_search_evidence_records;
create index idx_research_web_search_evidence_security_tab
  on research_web_search_evidence_records(security_code, tab_id, created_at desc);
