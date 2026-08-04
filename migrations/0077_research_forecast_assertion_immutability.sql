-- Provenance decisions are append-only.  Corrections must create a new
-- document version/assertion rather than rewriting the historical chain.
create trigger prevent_research_forecast_source_identity_assertion_update
before update on research_forecast_source_identity_assertions
begin
  select raise(abort, 'forecast source identity assertions are immutable');
end;

create trigger prevent_research_forecast_source_identity_assertion_delete
before delete on research_forecast_source_identity_assertions
begin
  select raise(abort, 'forecast source identity assertions are immutable');
end;

create trigger prevent_research_forecast_model_lineage_update
before update on research_forecast_model_lineages
begin
  select raise(abort, 'forecast model lineages are immutable');
end;

create trigger prevent_research_forecast_model_lineage_delete
before delete on research_forecast_model_lineages
begin
  select raise(abort, 'forecast model lineages are immutable');
end;
