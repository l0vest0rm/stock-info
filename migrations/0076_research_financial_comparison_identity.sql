-- Comparison identity is separate from the provider's transport/display id.
-- In particular, Eastmoney has changed fiscalPeriod labels and row ordering
-- without changing a reported statement field. Existing observations remain
-- immutable and deliberately have NULL here; a replay appends a new,
-- canonically keyed observation rather than rewriting audit history.

alter table research_financial_statutory_verifications
  add column canonical_comparison_key text;

create index idx_research_financial_statutory_verifications_comparison
  on research_financial_statutory_verifications(
    security_code, canonical_comparison_key, statutory_provider, outcome, observed_at desc
  );

-- Candidate rows freeze the comparison identity that linked their statutory
-- observation to the structured primary fact. Historical candidate rows are
-- intentionally not backfilled or reassigned.
alter table research_formal_actual_candidates
  add column canonical_comparison_key text;

create index idx_research_formal_actual_candidates_comparison
  on research_formal_actual_candidates(security_code, canonical_comparison_key, created_at desc);
