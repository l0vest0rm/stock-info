-- Model outputs are revisions, not a cache keyed by source input. Rebuild the
-- original table to remove its input fingerprint uniqueness constraint while
-- preserving every previously generated report and its later-added columns.
create table research_operating_analysis_runs_next (
  run_id text primary key,
  security_code text not null,
  prompt_version text not null,
  input_fingerprint text not null,
  input_as_of integer not null,
  input_json text not null,
  report_markdown text not null,
  provider text not null,
  generated_at integer not null,
  reasoning_markdown text not null default '',
  total_duration_ms integer,
  stream_stats_json text,
  prompt_json text
);

insert into research_operating_analysis_runs_next (
  run_id, security_code, prompt_version, input_fingerprint, input_as_of, input_json,
  report_markdown, provider, generated_at, reasoning_markdown, total_duration_ms,
  stream_stats_json, prompt_json
)
select run_id, security_code, prompt_version, input_fingerprint, input_as_of, input_json,
  report_markdown, provider, generated_at, reasoning_markdown, total_duration_ms,
  stream_stats_json, prompt_json
from research_operating_analysis_runs;

drop table research_operating_analysis_runs;
alter table research_operating_analysis_runs_next rename to research_operating_analysis_runs;
create index idx_research_operating_analysis_runs_current
  on research_operating_analysis_runs (security_code, generated_at desc);
