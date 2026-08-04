-- Public research risk records must not store owner-specific portfolio data.
-- Keep existing rows intact for audit, but make new leakage impossible even if
-- an old client bypasses the current API validation.
create trigger if not exists trg_research_risk_entries_reject_user_portfolio_insert
before insert on research_risk_entries
when new.scope = 'user_portfolio'
begin
  select raise(abort, 'public research risk scope cannot be user_portfolio');
end;
