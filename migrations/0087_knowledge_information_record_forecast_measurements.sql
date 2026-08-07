-- A generic information record remains a concise source statement. For a
-- third-party forecast it may additionally retain the model-extracted,
-- source-declared measurement contract needed by the automatic forecast
-- ledger. Historical rows deliberately remain `{}` and therefore cannot be
-- promoted merely because their prose happens to contain a number.
alter table knowledge_information_records
  add column forecast_measurement_json text not null default '{}';
