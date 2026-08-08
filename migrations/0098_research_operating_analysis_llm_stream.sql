-- The local Node runner persists partial text while llm-client consumes the
-- Responses stream.  The Worker only exposes this D1 state to polling pages.
alter table research_operating_analysis_jobs add column partial_report_markdown text;
alter table research_operating_analysis_jobs add column partial_updated_at integer;

create table if not exists research_operating_analysis_runner_leases (
  lease_name text primary key,
  owner_id text not null,
  heartbeat_at integer not null
);
