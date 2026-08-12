-- The current investment-analysis page owns one latest-only ChatGPT report
-- per security. taskd stores execution state; this table stores only the
-- verified business projection and the frozen engineering input that produced
-- it. No taskd task ID or local lease is retained.
create table if not exists research_investment_analysis_results (
  security_code text primary key,
  input_json text not null,
  markdown text not null,
  citations_json text not null,
  sources_json text not null,
  terminal_evidence_json text,
  projected_at integer not null
);
