-- A single local runner owns WebQA work at a time.  Job ownership survives a
-- Worker restart, while the short runner heartbeat makes a dead runner
-- recoverable without waiting for the long provider-request safety timeout.
create table if not exists research_webqa_runner_leases (
  lease_name text primary key,
  owner_id text not null,
  heartbeat_at integer not null
);

alter table research_operating_analysis_jobs add column lease_owner text;
alter table research_investment_review_jobs add column lease_owner text;

create index if not exists idx_research_operating_analysis_jobs_claim
  on research_operating_analysis_jobs (prompt_version, status, created_at);

create index if not exists idx_research_investment_review_jobs_claim
  on research_investment_review_jobs (prompt_version, status, created_at);
