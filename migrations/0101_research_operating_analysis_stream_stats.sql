-- Retain only compact, provider-reported stream counters. Raw Responses events
-- can contain model output and must not be copied into the polling read model.
alter table research_operating_analysis_jobs add column partial_stream_stats_json text;
alter table research_operating_analysis_runs add column stream_stats_json text;
