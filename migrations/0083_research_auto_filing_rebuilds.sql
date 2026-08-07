-- Materialized rebuild metadata for the automatic filing-input pipeline.  The
-- actual page read models remain source-bound queries; this table proves which
-- current source set they were rebuilt from and lets a local scheduler consume
-- dependency events without any page-side write or human approval.
create table research_auto_filing_module_rebuilds (
  rebuild_id text primary key,
  security_code text not null,
  target_module text not null check (target_module in ('operating', 'market', 'governance', 'industry', 'forecast', 'risk')),
  source_signature text not null,
  source_document_count integer not null,
  source_fact_count integer not null,
  latest_processed_at integer,
  change_reason text not null,
  rebuilt_at integer not null,
  unique(security_code, target_module, source_signature)
);
create index idx_research_auto_filing_module_rebuilds_current
  on research_auto_filing_module_rebuilds(security_code, target_module, rebuilt_at desc);
