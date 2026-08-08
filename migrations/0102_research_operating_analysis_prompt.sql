-- Keep the exact model instructions and rendered user prompt that produced a
-- report. The page reads this durable copy instead of reconstructing it.
alter table research_operating_analysis_jobs add column prompt_json text;
alter table research_operating_analysis_runs add column prompt_json text;
