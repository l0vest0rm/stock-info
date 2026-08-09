-- Generic local LLM execution protocol.
--
-- These tables own task/run lifecycle and terminal model artifacts only.  They
-- deliberately do not replace the business projections (research reports,
-- Web Search evidence, or the forecast ledger), and they never store a
-- token-by-token/periodic partial body.
create table if not exists llm_tasks (
  task_id text primary key,
  task_type text not null,
  target_type text not null,
  target_id text not null,
  idempotency_key text not null,
  protocol_version text not null,
  prompt_version text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'blocked')),
  requested_model text,
  requested_reasoning_effort text,
  last_run_id text,
  metadata_json text,
  last_error_code text,
  last_error_message text,
  created_at integer not null,
  started_at integer,
  completed_at integer,
  updated_at integer not null,
  unique (task_type, target_type, target_id, idempotency_key, protocol_version, prompt_version)
);

create index if not exists idx_llm_tasks_claim
  on llm_tasks (status, task_type, created_at, updated_at);
create index if not exists idx_llm_tasks_target
  on llm_tasks (target_type, target_id, updated_at desc);

create table if not exists llm_runs (
  run_id text primary key,
  task_id text not null,
  attempt integer not null,
  provider text not null,
  model text not null,
  reasoning_effort text,
  prompt_version text not null,
  input_fingerprint text,
  input_as_of integer,
  input_json text,
  prompt_json text,
  status text not null check (status in ('running', 'completed', 'failed', 'blocked')),
  lease_owner text,
  lease_until integer,
  heartbeat_at integer,
  current_step_key text,
  progress_json text,
  progress_updated_at integer,
  terminal_metadata_json text,
  error_code text,
  error_message text,
  started_at integer not null,
  completed_at integer,
  updated_at integer not null,
  unique (task_id, attempt),
  foreign key (task_id) references llm_tasks(task_id) on delete cascade
);

create index if not exists idx_llm_runs_task
  on llm_runs (task_id, attempt desc);
create index if not exists idx_llm_runs_claim
  on llm_runs (status, lease_until, updated_at);

create table if not exists llm_run_artifacts (
  artifact_id text primary key,
  run_id text not null,
  step_key text not null,
  upstream_artifact_ids_json text not null default '[]',
  output_type text not null check (output_type in ('json', 'markdown')),
  status text not null check (status in ('complete', 'partial', 'blocked', 'not_applicable', 'failed')),
  output_json text,
  output_markdown text,
  structure_valid integer,
  blocked_json text,
  error_code text,
  error_message text,
  terminal_metadata_json text,
  completed_at integer not null,
  unique (run_id, step_key),
  foreign key (run_id) references llm_runs(run_id) on delete cascade
);

create index if not exists idx_llm_run_artifacts_run
  on llm_run_artifacts (run_id, completed_at, step_key);
