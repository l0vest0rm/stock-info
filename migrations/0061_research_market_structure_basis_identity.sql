-- The same official filing can disclose both a weighted-average EPS
-- denominator and a point-in-time outstanding-share count for the same
-- security/date.  They are distinct, immutable observations with different
-- downstream eligibility, so the measurement basis is part of their source
-- identity.  Keep a single uniqueness rule for non-share facts by
-- normalising their null basis to an empty string inside the index.
drop index idx_research_market_structure_fact_version;
create unique index idx_research_market_structure_fact_version
  on research_market_structure_facts(
    security_code,
    fact_key,
    as_of,
    source_url,
    coalesce(measurement_basis, '')
  );
