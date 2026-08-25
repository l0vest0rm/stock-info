-- Register only concrete US series whose provider, statistical definition,
-- frequency and publication-time contract have been reviewed.  Every other
-- catalog row deliberately remains visible but unscheduled: it must not be
-- filled with a mirror, a proxy or a superficially similar series.
--
-- FRED is the high-frequency source because its authenticated observations
-- API returns `realtime_start`.  The four BLS rows use the narrow, explicit
-- release-calendar contract accepted by the scheduler.  This migration runs
-- after 0136, so it updates the retained native row when one exists and the
-- stable US placeholder otherwise.

create temp table macro_verified_us_sources_0137 (
  metric_id integer primary key,
  source_id text not null,
  source_series_id text not null,
  source_url text not null,
  publisher text not null,
  publication_timestamp_strategy text not null,
  source_batch_key text not null,
  frequency text not null,
  unit text not null,
  unit_format text not null,
  seasonal_adjustment text,
  measurement_kind text not null,
  statistical_definition text not null,
  refresh_interval_seconds integer not null,
  revision_lookback_periods integer not null,
  stale_after_seconds integer not null,
  lead_lag text
);

insert into macro_verified_us_sources_0137 values
  (1, 'fred', 'GDPC1', 'https://fred.stlouisfed.org/series/GDPC1', 'U.S. Bureau of Economic Analysis via FRED', 'fred_realtime_start', 'fred:GDPC1', 'quarterly', 'billions of chained 2017 dollars', 'decimal_1', 'seasonally_adjusted_annual_rate', 'level', 'BEA real GDP, seasonally adjusted annual rate.', 86400, 16, 15552000, 'coincident'),
  (2, 'fred', 'GDP', 'https://fred.stlouisfed.org/series/GDP', 'U.S. Bureau of Economic Analysis via FRED', 'fred_realtime_start', 'fred:GDP', 'quarterly', 'billions of dollars', 'decimal_1', 'seasonally_adjusted_annual_rate', 'level', 'BEA current-dollar GDP, seasonally adjusted annual rate.', 86400, 16, 15552000, 'coincident'),
  (3, 'fred', 'INDPRO', 'https://fred.stlouisfed.org/series/INDPRO', 'Federal Reserve via FRED', 'fred_realtime_start', 'fred:INDPRO', 'monthly', 'index 2017=100', 'decimal_2', 'seasonally_adjusted', 'index', 'Federal Reserve industrial production index.', 86400, 24, 7776000, 'coincident'),
  (4, 'fred', 'PCEC96', 'https://fred.stlouisfed.org/series/PCEC96', 'U.S. Bureau of Economic Analysis via FRED', 'fred_realtime_start', 'fred:PCEC96', 'monthly', 'billions of chained 2017 dollars', 'decimal_1', 'seasonally_adjusted_annual_rate', 'level', 'BEA real personal consumption expenditures.', 86400, 24, 7776000, 'coincident'),
  (5, 'fred', 'RSAFS', 'https://fred.stlouisfed.org/series/RSAFS', 'U.S. Census Bureau via FRED', 'fred_realtime_start', 'fred:RSAFS', 'monthly', 'millions of dollars', 'decimal_0', 'seasonally_adjusted', 'level', 'Advance retail and food services sales, seasonally adjusted.', 86400, 24, 7776000, 'coincident'),
  (6, 'fred', 'GPDIC1', 'https://fred.stlouisfed.org/series/GPDIC1', 'U.S. Bureau of Economic Analysis via FRED', 'fred_realtime_start', 'fred:GPDIC1', 'quarterly', 'billions of chained 2017 dollars', 'decimal_1', 'seasonally_adjusted_annual_rate', 'level', 'BEA real gross private domestic investment; this is not total economy-wide capital formation.', 86400, 16, 15552000, 'coincident'),
  (7, 'fred', 'NAPM', 'https://fred.stlouisfed.org/series/NAPM', 'Institute for Supply Management via FRED', 'fred_realtime_start', 'fred:NAPM', 'monthly', 'diffusion index', 'decimal_1', 'not_applicable', 'index', 'ISM manufacturing PMI.', 86400, 24, 7776000, 'leading'),
  (9, 'fred', 'NAPMNOI', 'https://fred.stlouisfed.org/series/NAPMNOI', 'Institute for Supply Management via FRED', 'fred_realtime_start', 'fred:NAPMNOI', 'monthly', 'diffusion index', 'decimal_1', 'not_applicable', 'index', 'ISM manufacturing new-orders index.', 86400, 24, 7776000, 'leading'),
  (10, 'fred', 'ISRATIO', 'https://fred.stlouisfed.org/series/ISRATIO', 'U.S. Census Bureau via FRED', 'fred_realtime_start', 'fred:ISRATIO', 'monthly', 'ratio', 'decimal_2', 'seasonally_adjusted', 'ratio', 'Total business inventories-to-sales ratio.', 86400, 24, 7776000, 'coincident'),
  (11, 'fred', 'TCU', 'https://fred.stlouisfed.org/series/TCU', 'Federal Reserve via FRED', 'fred_realtime_start', 'fred:TCU', 'monthly', '%', 'percent', 'seasonally_adjusted', 'rate', 'Total capacity utilization.', 86400, 24, 7776000, 'coincident'),
  (12, 'fred', 'UMCSENT', 'https://fred.stlouisfed.org/series/UMCSENT', 'University of Michigan via FRED', 'fred_realtime_start', 'fred:UMCSENT', 'monthly', 'index', 'decimal_1', 'not_applicable', 'index', 'University of Michigan consumer sentiment index.', 86400, 24, 7776000, 'leading'),
  (5 + 9, 'bls', 'LNS14000000', 'https://data.bls.gov/timeseries/LNS14000000', 'U.S. Bureau of Labor Statistics', 'bls_release_calendar', 'bls:employment', 'monthly', '%', 'percent', 'seasonally_adjusted', 'rate', 'BLS civilian unemployment rate, seasonally adjusted.', 86400, 24, 7776000, 'lagging'),
  (15, 'bls', 'LNS11300000', 'https://data.bls.gov/timeseries/LNS11300000', 'U.S. Bureau of Labor Statistics', 'bls_release_calendar', 'bls:employment', 'monthly', '%', 'percent', 'seasonally_adjusted', 'rate', 'BLS labor-force participation rate, seasonally adjusted.', 86400, 24, 7776000, 'lagging'),
  (16, 'bls', 'JTS000000000000000JOL', 'https://data.bls.gov/timeseries/JTS000000000000000JOL', 'U.S. Bureau of Labor Statistics', 'bls_release_calendar', 'bls:jolts', 'monthly', 'thousands of persons', 'decimal_0', 'seasonally_adjusted', 'level', 'BLS JOLTS job openings, total nonfarm.', 86400, 24, 7776000, 'lagging'),
  (18, 'fred', 'DSPIC96', 'https://fred.stlouisfed.org/series/DSPIC96', 'U.S. Bureau of Economic Analysis via FRED', 'fred_realtime_start', 'fred:DSPIC96', 'monthly', 'billions of chained 2017 dollars', 'decimal_1', 'seasonally_adjusted_annual_rate', 'level', 'BEA real disposable personal income.', 86400, 24, 7776000, 'coincident'),
  (19, 'fred', 'CPIAUCSL', 'https://fred.stlouisfed.org/series/CPIAUCSL', 'U.S. Bureau of Labor Statistics via FRED', 'fred_realtime_start', 'fred:CPIAUCSL', 'monthly', 'index 1982-84=100', 'decimal_2', 'seasonally_adjusted', 'index', 'BLS all-items CPI for all urban consumers, seasonally adjusted.', 86400, 24, 7776000, 'lagging'),
  (20, 'fred', 'CPILFESL', 'https://fred.stlouisfed.org/series/CPILFESL', 'U.S. Bureau of Labor Statistics via FRED', 'fred_realtime_start', 'fred:CPILFESL', 'monthly', 'index 1982-84=100', 'decimal_2', 'seasonally_adjusted', 'index', 'BLS core CPI excluding food and energy, seasonally adjusted.', 86400, 24, 7776000, 'lagging'),
  (22, 'fred', 'CUSR0000SAH1', 'https://fred.stlouisfed.org/series/CUSR0000SAH1', 'U.S. Bureau of Labor Statistics via FRED', 'fred_realtime_start', 'fred:CUSR0000SAH1', 'monthly', 'index 1982-84=100', 'decimal_2', 'seasonally_adjusted', 'index', 'BLS CPI shelter component, seasonally adjusted.', 86400, 24, 7776000, 'lagging'),
  (23, 'bls', 'WPUFD4', 'https://data.bls.gov/timeseries/WPUFD4', 'U.S. Bureau of Labor Statistics', 'bls_release_calendar', 'bls:ppi', 'monthly', 'index 1982=100', 'decimal_2', 'not_applicable', 'index', 'BLS producer price index, final demand.', 86400, 24, 7776000, 'lagging'),
  (25, 'fred', 'T5YIE', 'https://fred.stlouisfed.org/series/T5YIE', 'Federal Reserve Bank of St. Louis via FRED', 'fred_realtime_start', 'fred:T5YIE', 'daily', '%', 'percent', 'not_applicable', 'rate', '5-year forward inflation expectation rate, 5 years hence.', 21600, 260, 604800, 'leading'),
  (26, 'fred', 'MICH', 'https://fred.stlouisfed.org/series/MICH', 'University of Michigan via FRED', 'fred_realtime_start', 'fred:MICH', 'monthly', '%', 'percent', 'not_applicable', 'rate', 'University of Michigan median expected inflation, next 12 months.', 86400, 24, 7776000, 'leading'),
  (27, 'fred', 'DFF', 'https://fred.stlouisfed.org/series/DFF', 'Federal Reserve Bank of New York via FRED', 'fred_realtime_start', 'fred:DFF', 'daily', '%', 'percent', 'not_applicable', 'rate', 'Effective federal funds rate.', 21600, 260, 604800, 'coincident'),
  (28, 'fred', 'DGS2', 'https://fred.stlouisfed.org/series/DGS2', 'U.S. Treasury via FRED', 'fred_realtime_start', 'fred:DGS2', 'daily', '%', 'percent', 'not_applicable', 'rate', 'Market yield on U.S. Treasury securities at 2-year maturity.', 21600, 260, 604800, 'leading'),
  (29, 'fred', 'DGS10', 'https://fred.stlouisfed.org/series/DGS10', 'U.S. Treasury via FRED', 'fred_realtime_start', 'fred:DGS10', 'daily', '%', 'percent', 'not_applicable', 'rate', 'Market yield on U.S. Treasury securities at 10-year maturity.', 21600, 260, 604800, 'leading'),
  (30, 'fred', 'M2SL', 'https://fred.stlouisfed.org/series/M2SL', 'Board of Governors of the Federal Reserve System via FRED', 'fred_realtime_start', 'fred:M2SL', 'monthly', 'billions of dollars', 'decimal_1', 'seasonally_adjusted', 'level', 'M2 money stock, seasonally adjusted.', 86400, 24, 7776000, 'coincident'),
  (31, 'fred', 'TOTLL', 'https://fred.stlouisfed.org/series/TOTLL', 'Board of Governors of the Federal Reserve System via FRED', 'fred_realtime_start', 'fred:TOTLL', 'quarterly', 'billions of dollars', 'decimal_1', 'seasonally_adjusted', 'level', 'Total loans and leases at commercial banks.', 86400, 16, 15552000, 'coincident'),
  (32, 'fred', 'DRTSCILM', 'https://fred.stlouisfed.org/series/DRTSCILM', 'Board of Governors of the Federal Reserve System via FRED', 'fred_realtime_start', 'fred:DRTSCILM', 'quarterly', '%', 'percent', 'not_applicable', 'rate', 'Banks tightening standards for commercial and industrial loans to large and middle-market firms.', 86400, 16, 15552000, 'leading'),
  (47, 'fred', 'CSUSHPINSA', 'https://fred.stlouisfed.org/series/CSUSHPINSA', 'S&P Dow Jones Indices via FRED', 'fred_realtime_start', 'fred:CSUSHPINSA', 'monthly', 'index Jan 2000=100', 'decimal_2', 'seasonally_adjusted', 'index', 'S&P CoreLogic Case-Shiller U.S. national home price index.', 86400, 24, 7776000, 'lagging'),
  (48, 'fred', 'EXHOSLUSM495S', 'https://fred.stlouisfed.org/series/EXHOSLUSM495S', 'National Association of Realtors via FRED', 'fred_realtime_start', 'fred:EXHOSLUSM495S', 'monthly', 'thousands of units', 'decimal_0', 'seasonally_adjusted_annual_rate', 'level', 'Existing home sales, seasonally adjusted annual rate.', 86400, 24, 7776000, 'coincident'),
  (49, 'fred', 'PRFI', 'https://fred.stlouisfed.org/series/PRFI', 'U.S. Bureau of Economic Analysis via FRED', 'fred_realtime_start', 'fred:PRFI', 'quarterly', 'billions of dollars', 'decimal_1', 'seasonally_adjusted_annual_rate', 'level', 'Private residential fixed investment, current-dollar annual rate.', 86400, 16, 15552000, 'coincident'),
  (50, 'fred', 'MORTGAGE30US', 'https://fred.stlouisfed.org/series/MORTGAGE30US', 'Freddie Mac via FRED', 'fred_realtime_start', 'fred:MORTGAGE30US', 'weekly', '%', 'percent', 'not_applicable', 'rate', '30-year fixed-rate mortgage average.', 21600, 104, 2592000, 'leading'),
  (52, 'fred', 'SP500', 'https://fred.stlouisfed.org/series/SP500', 'S&P Dow Jones Indices via FRED', 'fred_realtime_start', 'fred:SP500', 'daily', 'index', 'decimal_2', 'not_applicable', 'index', 'S&P 500 closing price index.', 21600, 260, 604800, 'coincident'),
  (53, 'fred', 'VIXCLS', 'https://fred.stlouisfed.org/series/VIXCLS', 'Cboe via FRED', 'fred_realtime_start', 'fred:VIXCLS', 'daily', 'index', 'decimal_2', 'not_applicable', 'index', 'CBOE volatility index (VIX).', 21600, 260, 604800, 'leading'),
  (54, 'fred', 'NFCI', 'https://fred.stlouisfed.org/series/NFCI', 'Federal Reserve Bank of Chicago via FRED', 'fred_realtime_start', 'fred:NFCI', 'weekly', 'index', 'decimal_2', 'not_applicable', 'index', 'Chicago Fed National Financial Conditions Index.', 86400, 104, 2592000, 'leading'),
  (55, 'fred', 'DCOILBRENTEU', 'https://fred.stlouisfed.org/series/DCOILBRENTEU', 'U.S. Energy Information Administration via FRED', 'fred_realtime_start', 'fred:DCOILBRENTEU', 'daily', 'dollars per barrel', 'decimal_2', 'not_applicable', 'level', 'Europe Brent spot price FOB.', 21600, 260, 604800, 'coincident'),
  (56, 'fred', 'DHHNGSP', 'https://fred.stlouisfed.org/series/DHHNGSP', 'U.S. Energy Information Administration via FRED', 'fred_realtime_start', 'fred:DHHNGSP', 'daily', 'dollars per million Btu', 'decimal_2', 'not_applicable', 'level', 'Henry Hub natural-gas spot price.', 21600, 260, 604800, 'coincident'),
  (59, 'fred', 'GOLDAMGBD228NLBM', 'https://fred.stlouisfed.org/series/GOLDAMGBD228NLBM', 'ICE Benchmark Administration via FRED', 'fred_realtime_start', 'fred:GOLDAMGBD228NLBM', 'daily', 'dollars per troy ounce', 'decimal_2', 'not_applicable', 'level', 'London Bullion Market Association gold fixing price.', 21600, 260, 604800, 'coincident');

update macro_indicators
set
  source_id = (select source_id from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  source_series_id = (select source_series_id from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  source_url = (select source_url from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  publisher = (select publisher from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  publication_timestamp_strategy = (select publication_timestamp_strategy from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  source_batch_key = (select source_batch_key from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  frequency = (select frequency from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  unit = (select unit from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  unit_format = (select unit_format from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  seasonal_adjustment = (select seasonal_adjustment from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  measurement_kind = (select measurement_kind from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  statistical_definition = (select statistical_definition from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  refresh_interval_seconds = (select refresh_interval_seconds from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  revision_lookback_periods = (select revision_lookback_periods from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  stale_after_seconds = (select stale_after_seconds from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  lead_lag = (select lead_lag from macro_verified_us_sources_0137 s where s.metric_id = macro_indicators.metric_id),
  next_fetch_at = 0,
  last_error = null
where region_code = 'US'
  and definition_id = 0
  and enabled = 1
  and metric_id in (select metric_id from macro_verified_us_sources_0137);

-- 0134's GDP-growth series predated the raw-versus-display boundary.  Preserve
-- its indicator IDs, but remove its GDP-growth facts before correcting the
-- source identity to WEO real GDP in national currency. Those values are a
-- different economic concept and must never be relabelled as raw GDP. 0136 assigns this to A01 with
-- definition_id=1, so it remains distinct from domestic quarterly real GDP.
delete from macro_data where indicator_id in (10001, 10002);

update macro_indicators
set
  source_series_id = case region_code
    when 'CN' then 'IMF/WEO:2025-04/CHN.NGDP_R.national_currency'
    when 'US' then 'IMF/WEO:2025-04/USA.NGDP_R.national_currency'
  end,
  source_url = case region_code
    when 'CN' then 'https://api.db.nomics.world/v22/series/IMF/WEO:2025-04/CHN.NGDP_R.national_currency?observations=1'
    when 'US' then 'https://api.db.nomics.world/v22/series/IMF/WEO:2025-04/USA.NGDP_R.national_currency?observations=1'
  end,
  name = case region_code
    when 'CN' then '中国实际 GDP（IMF WEO 2025年4月）'
    when 'US' then '美国实际 GDP（IMF WEO 2025年4月）'
  end,
  statistical_definition = 'IMF WEO 2025年4月版的实际 GDP（不变价、本币）；年度定义，不等同于本国高频口径。',
  frequency = 'annual',
  unit = '十亿本币',
  unit_format = 'decimal_1',
  seasonal_adjustment = 'not_applicable',
  measurement_kind = 'level',
  yoy_method = 'percent_change',
  yoy_base_periods = 1,
  yoy_display_format = 'percent',
  mom_method = 'not_applicable',
  mom_base_periods = 0,
  mom_display_format = 'number',
  next_fetch_at = 0
where id in (10001, 10002)
  and metric_id = 1
  and definition_id = 1;

drop table macro_verified_us_sources_0137;
