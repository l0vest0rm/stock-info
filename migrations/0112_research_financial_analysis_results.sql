-- Business-owned projections of taskd financial-analysis results. The remote
-- task identity is derived from security_code + input_fingerprint + prompt
-- version; no taskd task_id is stored locally.
create table if not exists research_financial_analysis_results (
  security_code text not null,
  input_fingerprint text not null,
  prompt_version text not null,
  snapshot_json text not null,
  markdown text not null,
  citations_json text not null,
  sources_json text not null,
  terminal_evidence_json text,
  projected_at integer not null,
  primary key (security_code, input_fingerprint, prompt_version)
);
