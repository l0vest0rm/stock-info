-- The situation-awareness module and all of its persisted projections were
-- retired together. Drop dependent tables first so both SQLite and D1 honor
-- their foreign-key relationships during the cleanup.
drop table if exists situation_candidate_dispositions;
drop table if exists situation_action_candidates;
drop table if exists situation_impacts;
drop table if exists situation_snapshots;
drop table if exists situation_event_evidence;
drop table if exists situation_knowledge_imports;
drop table if exists situation_events;
drop table if exists situation_evidence;
drop table if exists situation_signals;
drop table if exists situation_holding_profiles;
drop table if exists situation_portfolio_rules;
drop table if exists situation_sources;
