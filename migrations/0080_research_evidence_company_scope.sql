-- A source document may be reused across a confirmed A/H/ADR group, but it
-- may never become an operating/industry input for a different company.  The
-- application checks this too; these triggers keep direct local D1 writes,
-- scripts and future routes behind the same durable invariant.

create trigger if not exists research_industry_kpi_driver_binding_security_company_before_insert
before insert on research_industry_kpi_driver_bindings
begin
  select case when not exists (
    select 1
      from research_reusable_evidence_references evidence
      join research_listed_securities security on security.security_code=evidence.security_code
      join research_company_track_exposures exposure on exposure.company_track_exposure_id=new.company_track_exposure_id
      where evidence.evidence_reference_id=new.evidence_reference_id
        and evidence.security_code=new.security_code
        and security.mapping_status='confirmed'
        and security.company_id=exposure.company_id
  ) then raise(abort, 'industry KPI binding security is not confirmed for exposure company') end;
end;

create trigger if not exists research_operating_source_fact_security_company_before_insert
before insert on research_operating_source_facts
begin
  select case when not exists (
    select 1
      from research_reusable_evidence_references evidence
      join research_information_evidence_candidate_reviews review
        on review.candidate_review_id=evidence.candidate_review_id and review.decision='accepted'
      join research_listed_securities security on security.security_code=evidence.security_code
      where evidence.evidence_reference_id=new.evidence_reference_id
        and evidence.security_code=new.source_security_code
        and security.mapping_status='confirmed'
        and security.company_id=new.operating_company_id
  ) then raise(abort, 'operating source fact security is not confirmed for operating company') end;
end;
