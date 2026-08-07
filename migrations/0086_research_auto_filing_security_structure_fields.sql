-- A statutory filing may explicitly identify another listed security, an ADS
-- ratio, or the measurement basis of an outstanding-share count.  These are
-- source-bound extraction fields, not permission to merge issuers or reuse a
-- valuation across listings.
alter table research_auto_filing_insights add column related_security_code text;
alter table research_auto_filing_insights add column security_relationship_kind text;
alter table research_auto_filing_insights add column related_shares_per_security numeric;
alter table research_auto_filing_insights add column measurement_basis text;

alter table research_auto_filing_fact_inputs add column related_security_code text;
alter table research_auto_filing_fact_inputs add column security_relationship_kind text;
alter table research_auto_filing_fact_inputs add column related_shares_per_security numeric;
alter table research_auto_filing_fact_inputs add column measurement_basis text;

create index idx_research_auto_filing_fact_inputs_security_structure
  on research_auto_filing_fact_inputs(security_code, target_module, fact_type, validity_status, processed_at desc);
