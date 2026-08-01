-- Report-analysis cache versions used to be embedded in app_kv keys.  That made
-- every parser upgrade retain an unreachable full copy until a manual cleanup.
-- Stable keys now overwrite in place, so remove the superseded versioned entries.
delete from app_kv
where key glob 'company-reports-source:v*:*'
   or key glob 'report-forecast:v*:*'
   or key glob 'shared-report-analysis:v*:*'
   or key glob 'eastmoney-report-pdf-text:v*:*'
   or key glob 'knowledge-report-analysis:v*:*';
