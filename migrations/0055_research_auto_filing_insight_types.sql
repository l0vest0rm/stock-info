-- Typed facets preserve which downstream research input a source-bound filing
-- fact may support.  They are extraction metadata only: neither a model
-- output nor an authorization to use the fact as a valuation assumption.
alter table research_auto_filing_insights add column fact_type text;
alter table research_auto_filing_insights add column value_type text;
alter table research_auto_filing_insights add column unit text;

create index idx_research_auto_filing_insights_security_type
  on research_auto_filing_insights(security_code, tab_id, fact_type, processed_at desc);
