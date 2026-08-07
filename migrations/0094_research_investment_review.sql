create table if not exists research_investment_review_runs (
  run_id text primary key,
  security_code text not null,
  main_run_id text not null,
  prompt_version text not null,
  report_markdown text not null,
  provider text not null,
  generated_at integer not null,
  unique (security_code, main_run_id, prompt_version)
);

create index if not exists idx_research_investment_review_runs_current
  on research_investment_review_runs (security_code, main_run_id, generated_at desc);

create table if not exists research_investment_review_jobs (
  security_code text not null,
  main_run_id text not null,
  prompt_version text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  run_id text,
  attempt_count integer not null default 0,
  last_error text,
  created_at integer not null,
  started_at integer,
  completed_at integer,
  updated_at integer not null,
  primary key (security_code, main_run_id, prompt_version)
);
