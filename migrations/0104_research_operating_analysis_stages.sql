-- A research task is resumable at the stage boundary.  A stream may be lost,
-- but a completed stage is immutable input to every dependent stage.
create table if not exists research_operating_analysis_stage_artifacts (
  security_code text not null,
  prompt_version text not null,
  stage_key text not null check (stage_key in ('company_baseline','industry_validation','operating_analysis','financial_analysis','valuation_inputs','valuation_conclusion')),
  status text not null check (status in ('queued','running','complete','partial','blocked','not_applicable','failed')),
  attempt_count integer not null default 0,
  input_json text,
  prompt_json text,
  output_json text,
  output_markdown text,
  partial_output text,
  blocked_json text,
  last_error text,
  started_at integer,
  completed_at integer,
  updated_at integer not null,
  primary key (security_code, prompt_version, stage_key)
);

create index if not exists idx_research_operating_analysis_stage_artifacts_task
  on research_operating_analysis_stage_artifacts (security_code, prompt_version, updated_at);
