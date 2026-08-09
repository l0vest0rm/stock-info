-- Local long-running tasks all use queued -> running -> completed|failed.
-- `attempt` and the lease tuple are fencing tokens: only the current owner of
-- the current attempt may persist a checkpoint or a terminal result.
alter table research_web_search_package_jobs add column job_id text;
alter table research_web_search_package_jobs add column job_type text not null default 'research_web_search';
alter table research_web_search_package_jobs add column attempt integer not null default 0;
alter table research_web_search_package_jobs add column lease_owner text;
alter table research_web_search_package_jobs add column lease_until integer;
alter table research_web_search_package_jobs add column heartbeat_at integer;
update research_web_search_package_jobs
  set job_id = 'research-web-search:' || security_code || ':' || package_kind || ':' || prompt_version,
      attempt = attempt_count
  where job_id is null;
create unique index if not exists idx_research_web_search_package_jobs_job_id
  on research_web_search_package_jobs(job_id);
create index if not exists idx_research_web_search_package_jobs_claim_v2
  on research_web_search_package_jobs(status, lease_until, created_at);

alter table research_operating_analysis_jobs add column job_id text;
alter table research_operating_analysis_jobs add column job_type text not null default 'research_operating_analysis';
alter table research_operating_analysis_jobs add column attempt integer not null default 0;
alter table research_operating_analysis_jobs add column lease_until integer;
alter table research_operating_analysis_jobs add column heartbeat_at integer;
update research_operating_analysis_jobs
  set job_id = 'research-operating-analysis:' || security_code || ':' || prompt_version,
      attempt = attempt_count
  where job_id is null;
create unique index if not exists idx_research_operating_analysis_jobs_job_id
  on research_operating_analysis_jobs(job_id);
create index if not exists idx_research_operating_analysis_jobs_claim_v2
  on research_operating_analysis_jobs(status, lease_until, created_at);

alter table research_operating_analysis_stage_artifacts add column attempt integer not null default 0;
alter table research_operating_analysis_stage_artifacts add column lease_owner text;

-- Information processing predates the common protocol and called `running`
-- `processing`. Rebuild it so every long-task consumer has the same states.
create table information_processing_jobs_v2 (
  job_id text primary key,
  job_type text not null default 'information_processing',
  doc_id text not null unique,
  status text not null check (status in ('queued', 'running', 'completed', 'needs_review', 'failed')),
  attempt_count integer not null default 0,
  attempt integer not null default 0,
  trigger_source text not null default 'manual',
  lease_owner text,
  lease_until integer,
  heartbeat_at integer,
  last_run_id text,
  last_error text,
  created_at integer not null,
  started_at integer,
  completed_at integer,
  updated_at integer not null,
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict,
  foreign key(last_run_id) references knowledge_processing_runs(run_id) on delete set null
);
insert into information_processing_jobs_v2 (
  job_id, doc_id, status, attempt_count, attempt, trigger_source, last_run_id, last_error,
  created_at, started_at, completed_at, updated_at
)
select job_id, doc_id,
  case status when 'processing' then 'running' else status end,
  attempt_count, attempt_count, trigger_source, last_run_id, last_error,
  created_at,
  case when status = 'processing' then updated_at else null end,
  case when status in ('completed', 'needs_review', 'failed') then updated_at else null end,
  updated_at
from information_processing_jobs;
drop table information_processing_jobs;
alter table information_processing_jobs_v2 rename to information_processing_jobs;
create index idx_information_processing_jobs_queue on information_processing_jobs(status, created_at);
create index idx_information_processing_jobs_claim_v2 on information_processing_jobs(status, lease_until, created_at);

-- A DB-backed provider occupancy ledger is shared by the three separate Node
-- handlers. It enforces one global limit while each handler keeps its own cap.
create table if not exists local_job_provider_slots (
  provider_id text primary key,
  active_count integer not null default 0 check (active_count >= 0),
  concurrency_limit integer not null check (concurrency_limit > 0),
  updated_at integer not null
);
insert or ignore into local_job_provider_slots (provider_id, active_count, concurrency_limit, updated_at)
  values ('openai', 0, 5, unixepoch() * 1000);
create table if not exists local_job_provider_leases (
  provider_id text not null,
  job_id text not null,
  job_type text not null,
  attempt integer not null,
  lease_owner text not null,
  acquired_at integer not null,
  primary key (provider_id, job_id, attempt),
  unique (job_id, attempt)
);
create index if not exists idx_local_job_provider_leases_owner
  on local_job_provider_leases(provider_id, lease_owner, acquired_at);
