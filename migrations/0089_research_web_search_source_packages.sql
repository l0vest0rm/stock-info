-- Explicit, local-only Web Search tasks.  A page read never creates these
-- rows; one user click creates or reuses one source package for one security.
create table research_web_search_source_packages (
  package_id text primary key,
  security_code text not null,
  package_kind text not null check (package_kind in ('latest_annual_report', 'recent_filings', 'industry_market', 'peer_set', 'forecast_consensus', 'event_risk')),
  prompt_version text not null,
  model text not null,
  reasoning_effort text not null,
  status text not null check (status in ('completed', 'failed')),
  search_queries_json text not null,
  source_citations_json text not null,
  summary text not null,
  missing_fields_json text not null,
  conflicts_json text not null,
  refresh_triggers_json text not null,
  requested_at integer not null,
  completed_at integer not null,
  unique(security_code, package_kind, prompt_version)
);
create index idx_research_web_search_source_packages_security
  on research_web_search_source_packages(security_code, completed_at desc);

create table research_web_search_evidence_records (
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
  status text not null check (status in ('verified', 'unavailable')),
  created_at integer not null,
  foreign key(package_id) references research_web_search_source_packages(package_id) on delete cascade,
  unique(package_id, tab_id, field_key, source_url)
);
create index idx_research_web_search_evidence_security_tab
  on research_web_search_evidence_records(security_code, tab_id, created_at desc);
