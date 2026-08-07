-- The package identity is itself the durable task identity. No opaque job id
-- is needed to merge clicks, show state after reload, or atomically claim work.
create table research_web_search_package_jobs_v2 (
  security_code text not null,
  package_kind text not null check (package_kind in ('latest_annual_report', 'recent_filings', 'industry_market', 'peer_set', 'forecast_consensus', 'event_risk')),
  prompt_version text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  attempt_count integer not null default 0,
  package_id text,
  last_error text,
  created_at integer not null,
  started_at integer,
  completed_at integer,
  updated_at integer not null,
  primary key (security_code, package_kind, prompt_version),
  foreign key(package_id) references research_web_search_source_packages(package_id) on delete set null
);

insert into research_web_search_package_jobs_v2 (
  security_code, package_kind, prompt_version, status, attempt_count, package_id, last_error,
  created_at, started_at, completed_at, updated_at
)
select security_code, package_kind, prompt_version, status, attempt_count, package_id, last_error,
  created_at, started_at, completed_at, updated_at
from research_web_search_package_jobs;

drop table research_web_search_package_jobs;
alter table research_web_search_package_jobs_v2 rename to research_web_search_package_jobs;
create index idx_research_web_search_package_jobs_lookup
  on research_web_search_package_jobs(security_code, status, updated_at desc);
