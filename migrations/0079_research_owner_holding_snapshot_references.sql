-- A private holding may point at a frozen public-research snapshot, but the
-- relationship is deliberately one-way.  It neither copies public content
-- into a decision record nor permits a private holding to alter research.
create table research_owner_holding_snapshot_references (
  reference_id text primary key,
  owner_key text not null,
  holding_security_code text not null,
  public_snapshot_id text not null,
  created_at integer not null,
  foreign key(public_snapshot_id) references research_analysis_snapshots(analysis_snapshot_id) on delete restrict,
  unique(owner_key, holding_security_code, public_snapshot_id)
);

create index idx_research_owner_holding_snapshot_references_owner_holding
  on research_owner_holding_snapshot_references(owner_key, holding_security_code, created_at desc);

-- Presence of a holding profile is checked at the database boundary as well
-- as in the application.  The profile's opaque JSON is intentionally never
-- read into the public-research tables.
create trigger trg_research_owner_holding_snapshot_reference_requires_holding
before insert on research_owner_holding_snapshot_references
when not exists (
  select 1 from situation_holding_profiles
  where owner_key = new.owner_key and code = new.holding_security_code
)
begin
  select raise(abort, 'owner holding profile is required before adding a public research snapshot reference');
end;

-- A link is valid only for a typed public-research snapshot of the exact same
-- listed security.  This refuses legacy dossier snapshots, risk-only snapshots
-- and cross-listing shortcuts (A/H/ADR remain distinct securities).
create trigger trg_research_owner_holding_snapshot_reference_requires_public_snapshot
before insert on research_owner_holding_snapshot_references
when not exists (
  select 1 from research_analysis_snapshots
  where analysis_snapshot_id = new.public_snapshot_id
    and security_code = new.holding_security_code
    and json_extract(summary_json, '$.kind') = 'public_research_snapshot'
)
begin
  select raise(abort, 'reference requires a frozen public research snapshot for the same listed security');
end;

-- References are audit records.  Changing or deleting one would silently
-- rewrite the owner's historical decision context.
create trigger trg_research_owner_holding_snapshot_reference_immutable_update
before update on research_owner_holding_snapshot_references
begin
  select raise(abort, 'owner holding public snapshot references are immutable');
end;

create trigger trg_research_owner_holding_snapshot_reference_immutable_delete
before delete on research_owner_holding_snapshot_references
begin
  select raise(abort, 'owner holding public snapshot references are immutable');
end;
