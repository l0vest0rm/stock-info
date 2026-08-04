-- 0054 established the binding ledger. Keep the accepted-review condition in
-- the database guard as well as the application query, including databases
-- that had already applied the first ledger migration before this tightening.
drop trigger if exists research_industry_kpi_driver_binding_scope_before_insert;
create trigger research_industry_kpi_driver_binding_scope_before_insert
before insert on research_industry_kpi_driver_bindings
begin
  select case when not exists (
    select 1 from research_reusable_evidence_references evidence
      join research_information_evidence_candidate_reviews review
        on review.candidate_review_id = evidence.candidate_review_id and review.decision = 'accepted'
      where evidence.evidence_reference_id = new.evidence_reference_id and evidence.security_code = new.security_code
  ) then raise(abort, 'industry KPI binding evidence is not an accepted reference for security') end;
  select case when not exists (
    select 1
      from research_company_track_exposures exposure
      join research_industry_track_kpis kpi on kpi.track_profile_id = exposure.track_profile_id
      join research_operating_driver_plans plan on plan.operating_driver_plan_id = new.operating_driver_plan_id
      join research_operating_models_typed model on model.operating_model_id = plan.operating_model_id
      where exposure.company_track_exposure_id = new.company_track_exposure_id
        and kpi.kpi_id = new.industry_kpi_id
        and model.company_id = exposure.company_id
  ) then raise(abort, 'industry KPI binding track, exposure, and plan company do not match') end;
  select case when not exists (
    select 1
      from research_operating_driver_segment_years segment
      join research_operating_driver_plan_years plan_year on plan_year.operating_driver_plan_year_id = segment.operating_driver_plan_year_id
      where segment.operating_driver_segment_year_id = new.operating_driver_segment_year_id
        and plan_year.operating_driver_plan_id = new.operating_driver_plan_id
  ) then raise(abort, 'industry KPI binding driver segment does not belong to plan') end;
end;
