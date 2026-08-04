-- A share-count observation is unusable for per-security valuation unless its
-- measurement basis is explicit.  Weighted-average EPS denominators remain
-- valuable source evidence, but are not a period-end outstanding share count.
alter table research_market_structure_facts add column measurement_basis text;

create trigger research_market_structure_measurement_basis_before_insert
before insert on research_market_structure_facts
begin
  select case when new.fact_key in ('basic_shares', 'diluted_shares')
    and (new.measurement_basis is null or new.measurement_basis not in ('period_end_outstanding', 'weighted_average_eps'))
    then raise(abort, 'share-count market structure facts require a valid measurement basis') end;
  select case when new.fact_key not in ('basic_shares', 'diluted_shares')
    and new.measurement_basis is not null
    then raise(abort, 'measurement basis is only allowed for share-count market structure facts') end;
end;

create trigger research_market_structure_measurement_basis_before_update
before update of fact_key, measurement_basis on research_market_structure_facts
begin
  select case when new.fact_key in ('basic_shares', 'diluted_shares')
    and (new.measurement_basis is null or new.measurement_basis not in ('period_end_outstanding', 'weighted_average_eps'))
    then raise(abort, 'share-count market structure facts require a valid measurement basis') end;
  select case when new.fact_key not in ('basic_shares', 'diluted_shares')
    and new.measurement_basis is not null
    then raise(abort, 'measurement basis is only allowed for share-count market structure facts') end;
end;
