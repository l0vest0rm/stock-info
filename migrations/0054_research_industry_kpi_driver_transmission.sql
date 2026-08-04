-- A reviewed information record may motivate an industry KPI input only after
-- a researcher explicitly connects it to an industry track, company exposure,
-- driver-plan row and allowed deterministic rule.  The source text is never
-- parsed here and no write can update the driver plan by side effect.

create table if not exists research_industry_kpi_driver_bindings (
  industry_kpi_driver_binding_id text primary key,
  security_code text not null,
  evidence_reference_id text not null,
  company_track_exposure_id text not null,
  industry_kpi_id text not null,
  operating_driver_plan_id text not null,
  operating_driver_segment_year_id text not null,
  transmission_rule_id text not null,
  mapping_config_version text not null,
  input_value numeric not null,
  input_unit text not null,
  mapping_note text not null,
  mapped_by text not null,
  mapped_at integer not null,
  created_at integer not null,
  unique(operating_driver_segment_year_id, transmission_rule_id),
  foreign key(evidence_reference_id) references research_reusable_evidence_references(evidence_reference_id) on delete restrict,
  foreign key(company_track_exposure_id) references research_company_track_exposures(company_track_exposure_id) on delete restrict,
  foreign key(industry_kpi_id) references research_industry_track_kpis(kpi_id) on delete restrict,
  foreign key(operating_driver_plan_id) references research_operating_driver_plans(operating_driver_plan_id) on delete restrict,
  foreign key(operating_driver_segment_year_id) references research_operating_driver_segment_years(operating_driver_segment_year_id) on delete restrict
);
create index if not exists idx_research_industry_kpi_driver_bindings_security
  on research_industry_kpi_driver_bindings(security_code, operating_driver_plan_id, mapped_at desc);

-- Cross-table ownership and period checks are part of the durable write
-- contract, rather than a convention left to the browser.
create trigger if not exists research_industry_kpi_driver_binding_scope_before_insert
before insert on research_industry_kpi_driver_bindings
begin
  select case when not exists (
    select 1 from research_reusable_evidence_references evidence
      join research_information_evidence_candidate_reviews review
        on review.candidate_review_id = evidence.candidate_review_id and review.decision = 'accepted'
      where evidence.evidence_reference_id = new.evidence_reference_id and evidence.security_code = new.security_code
  ) then raise(abort, 'industry KPI binding evidence does not belong to security') end;
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
