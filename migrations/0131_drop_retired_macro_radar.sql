-- The macro redesign starts from a new CN/US catalog and numeric fact ledger.
-- These tables backed the retired market radar, calendar, alert and JSON-vintage
-- contracts.  They must not survive alongside macro_indicators/macro_data.
drop table if exists macro_alert_history;
drop table if exists macro_user_watch_configs;
drop table if exists macro_events;
drop table if exists macro_series_history;
drop table if exists macro_observation_vintages;
drop table if exists macro_source_health;
drop table if exists macro_series;

-- `sync_state/macro-data` belonged to the retired whole-module scheduler.
-- Keep the shared kv_cache table and all unrelated namespaces intact.
delete from kv_cache where namespace = 'sync_state' and key = 'macro-data';
