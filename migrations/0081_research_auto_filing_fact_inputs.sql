-- The remote-model extraction is source-bound evidence, but downstream
-- readers must not consume a UI-only summary.  This projection is an
-- automatic, read-only company research input: it retains the immutable
-- statutory quote and expressly forbids treating an extracted value as a
-- valuation assumption or generated conclusion.
create table research_auto_filing_fact_inputs (
  filing_fact_input_id text primary key,
  source_insight_id text not null unique,
  operating_company_id text,
  security_code text not null,
  statutory_document_id text not null,
  document_url text not null,
  target_module text not null check (target_module in ('operating', 'market', 'governance', 'industry', 'forecast', 'risk')),
  fact_type text not null,
  fact_key text not null,
  title text not null,
  statement text not null,
  reported_value text,
  value_type text not null check (value_type in ('qualitative', 'amount', 'count', 'ratio', 'range', 'date', 'unavailable')),
  unit text,
  report_period text,
  evidence_quote text not null,
  evidence_locator text not null,
  extraction_method text not null,
  prompt_version text not null,
  model text not null,
  usage_policy text not null check (usage_policy = 'source_bound_evidence_only_no_valuation'),
  processed_at integer not null,
  materialized_at integer not null
);

create index idx_research_auto_filing_fact_inputs_security_module
  on research_auto_filing_fact_inputs(security_code, target_module, processed_at desc);
create index idx_research_auto_filing_fact_inputs_company_module
  on research_auto_filing_fact_inputs(operating_company_id, target_module, processed_at desc);
