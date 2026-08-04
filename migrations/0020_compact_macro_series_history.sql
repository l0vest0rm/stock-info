-- Historical observations are read and written as one immutable JSON snapshot
-- per series. Tuple columns avoid repeated property names; source URL/R2-key
-- dictionaries avoid repeating long provenance strings for every daily value.
create table if not exists macro_series_history (
  series_id text primary key,
  vintages_json text not null,
  updated_at integer not null,
  foreign key(series_id) references macro_series(series_id) on delete cascade
);

with source_urls as (
  select distinct series_id, source_url from macro_observation_vintages where source_url is not null
), source_url_indexes as (
  select series_id, source_url, row_number() over (partition by series_id order by source_url) - 1 as dictionary_index
  from source_urls
), raw_r2_keys as (
  select distinct series_id, raw_r2_key from macro_observation_vintages where raw_r2_key is not null
), raw_r2_key_indexes as (
  select series_id, raw_r2_key, row_number() over (partition by series_id order by raw_r2_key) - 1 as dictionary_index
  from raw_r2_keys
)
insert into macro_series_history (series_id, vintages_json, updated_at)
select source.series_id,
  json_object(
    'v', 1,
    'u', json((select coalesce(json_group_array(source_url), '[]') from (
      select source_url from source_url_indexes where series_id = source.series_id order by dictionary_index
    ))),
    'r', json((select coalesce(json_group_array(raw_r2_key), '[]') from (
      select raw_r2_key from raw_r2_key_indexes where series_id = source.series_id order by dictionary_index
    ))),
    'o', json((select json_group_array(json_array(
      observation_date, released_at, vintage_at, revision_number, value,
      consensus, previous_value, is_preliminary,
      case quality_status when 'suspect' then 1 when 'missing' then 2 else 0 end,
      (select dictionary_index from source_url_indexes where series_id = observation.series_id and source_url = observation.source_url),
      (select dictionary_index from raw_r2_key_indexes where series_id = observation.series_id and raw_r2_key = observation.raw_r2_key),
      observed_at
    )) from macro_observation_vintages observation where observation.series_id = source.series_id))
  ),
  max(source.observed_at)
from macro_observation_vintages source
group by source.series_id
on conflict(series_id) do update set
  vintages_json = excluded.vintages_json,
  updated_at = excluded.updated_at;

delete from macro_observation_vintages;
drop table macro_observation_vintages;
