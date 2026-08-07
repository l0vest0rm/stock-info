-- Extend the source-bound filing read model with the financial/capital tab.
-- SQLite cannot alter a CHECK constraint in place, so preserve every existing
-- immutable extraction row while rebuilding the table definition.
alter table research_auto_filing_insights rename to research_auto_filing_insights_0053;

create table research_auto_filing_insights (
  insight_id text primary key,
  security_code text not null,
  registry text not null check (registry in ('cninfo', 'hkex', 'sec')),
  statutory_document_id text not null,
  document_url text not null,
  tab_id text not null check (tab_id in ('business', 'market', 'financial', 'industry', 'forecast', 'risk')),
  fact_key text not null,
  title text not null,
  statement text not null,
  reported_value text,
  report_period text,
  evidence_quote text not null,
  evidence_locator text not null,
  extraction_method text not null,
  prompt_version text not null,
  model text not null,
  processed_at integer not null,
  created_at integer not null,
  unique(security_code, statutory_document_id, tab_id, fact_key, prompt_version)
);

insert into research_auto_filing_insights (
  insight_id, security_code, registry, statutory_document_id, document_url,
  tab_id, fact_key, title, statement, reported_value, report_period,
  evidence_quote, evidence_locator, extraction_method, prompt_version,
  model, processed_at, created_at
)
select insight_id, security_code, registry, statutory_document_id, document_url,
  tab_id, fact_key, title, statement, reported_value, report_period,
  evidence_quote, evidence_locator, extraction_method, prompt_version,
  model, processed_at, created_at
from research_auto_filing_insights_0053;

drop table research_auto_filing_insights_0053;

create index idx_research_auto_filing_insights_security_tab
  on research_auto_filing_insights(security_code, tab_id, processed_at desc);
