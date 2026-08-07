alter table research_operating_analysis_jobs add column webqa_conversation_id text;
alter table research_operating_analysis_jobs add column start_new_session integer not null default 0;
