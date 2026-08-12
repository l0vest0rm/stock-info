insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
select
  case
    when key like 'company-reports-source:%' then 'company_reports_source'
    when key like 'report-forecast:%' then 'company_report_forecast'
    when key like 'shared-report-analysis:%' then 'shared_report_analysis'
    when key like 'knowledge-report-analysis:%' then 'knowledge_report_analysis'
    when key like 'company-news-report-analysis:%' then 'company_news_report_analysis'
    when key like 'sina-report-list:%' then 'sina_report_list'
    when key like 'sina-report-detail:%' then 'sina_report_detail'
    when key like 'eastmoney-report-pdf-text:%' then 'eastmoney_report_pdf_text'
    when key like 'financial-provisional-sync:%' then 'financial_provisional_sync'
    when key like 'llm-daily-quota:%' then 'daily_llm_quota'
    when key = 'companies-follow-config' then 'companies_follow_config'
    when key like 'us.options.chain.v2.%' then 'us_option_chain'
  end,
  key,
  value_json,
  expires_at,
  updated_at
from app_kv
where
  key like 'company-reports-source:%'
  or key like 'report-forecast:%'
  or key like 'shared-report-analysis:%'
  or key like 'knowledge-report-analysis:%'
  or key like 'company-news-report-analysis:%'
  or key like 'sina-report-list:%'
  or key like 'sina-report-detail:%'
  or key like 'eastmoney-report-pdf-text:%'
  or key like 'financial-provisional-sync:%'
  or key like 'llm-daily-quota:%'
  or key = 'companies-follow-config'
  or key like 'us.options.chain.v2.%'
on conflict(namespace, key) do update set
  value_json = excluded.value_json,
  expires_at = excluded.expires_at,
  updated_at = excluded.updated_at;

drop table if exists app_kv;
