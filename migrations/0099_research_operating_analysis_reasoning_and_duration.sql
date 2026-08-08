-- Preserve the model-returned reasoning summary independently from the final
-- report, so the polling page can show both while a local run is in progress
-- and after it completes.
alter table research_operating_analysis_runs add column reasoning_markdown text not null default '';
alter table research_operating_analysis_runs add column total_duration_ms integer;

alter table research_operating_analysis_jobs add column partial_reasoning_markdown text;
