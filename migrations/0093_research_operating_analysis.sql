create table if not exists research_operating_analysis_runs (
  run_id text primary key,
  security_code text not null,
  prompt_version text not null,
  input_fingerprint text not null,
  input_as_of integer not null,
  input_json text not null,
  report_markdown text not null,
  provider text not null,
  generated_at integer not null,
  unique (security_code, prompt_version, input_fingerprint)
);

create index if not exists idx_research_operating_analysis_runs_current
  on research_operating_analysis_runs (security_code, generated_at desc);

create table if not exists research_operating_analysis_jobs (
  security_code text not null,
  prompt_version text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  run_id text,
  attempt_count integer not null default 0,
  last_error text,
  created_at integer not null,
  started_at integer,
  completed_at integer,
  updated_at integer not null,
  primary key (security_code, prompt_version)
);
