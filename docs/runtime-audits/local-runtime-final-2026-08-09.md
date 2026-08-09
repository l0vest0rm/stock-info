# Local Node runtime baseline audit

Collected: 2026-08-09T04:10:50.419Z

Commands: `node scripts/audit-local-runtime.mjs --output <report.md>` ; `tar -tzf <retired-state.tar.gz>`

- Node SQLite: `/Users/terry/git/stock-info/data/local/stock-info.sqlite` (26222592 bytes, 172 tables)
- Canonical historical Miniflare D1: `not found`
- Machine-readable detail: `/Users/terry/git/stock-info/docs/runtime-audits/local-runtime-final-2026-08-09.json`

## Scoped database comparison

| Scope | Node SQLite | Miniflare D1 | Node-only primary keys | Miniflare-only primary keys |
| --- | --- | --- | ---: | ---: |
| securities | 9 rows; max updated_at=1786248548125 | absent | n/a | n/a |
| kline | absent | absent | n/a | n/a |
| knowledge documents | 19 rows; max published_at=2026-08-09T03:55:57.000Z, fetched_at=2026-08-09T04:00:00.412Z, event_time=2026-08-09T03:55:57.000Z, updated_at=1786248001222, sort_time=2026-08-09T03:55:57.000Z | absent | n/a | n/a |
| knowledge processing | 2 rows; max heartbeat_at=1786246781622, created_at=1786243071948, started_at=1786246781622, completed_at=1786246781623, updated_at=1786246781623 | absent | n/a | n/a |
| research web search | 1 rows; max created_at=1786247640292, started_at=1786247640342, completed_at=1786247995511, updated_at=1786247995511, heartbeat_at=1786247988154 | absent | n/a | n/a |
| research operating analysis | 0 rows; max created_at=null, started_at=null, completed_at=null, updated_at=null, partial_updated_at=null, heartbeat_at=null | absent | n/a | n/a |
| macro | 25 rows; max updated_at=1786248546526 | absent | n/a | n/a |
| situation | 1 rows; max occurred_at=1786241207000, first_seen_at=1786243200003, last_seen_at=1786243200003, created_at=1786243200003, updated_at=1786243200003 | absent | n/a | n/a |

The JSON report retains each scoped schema and every table's row count and maximum date-like field. Tables without compatible declared primary keys are deliberately not inferred equal.

## Runtime baseline

### Listeners

```text
none
```

### Repository-related processes

```text
  123     1 Wed Aug  5 07:30:27 2026     /usr/libexec/watchdogd
26192 25976 Sun Aug  9 12:07:43 2026     /opt/homebrew/Cellar/node/26.5.0/bin/node /Users/terry/git/stock-info/data/local/runtime/server.mjs
26203 25976 Sun Aug  9 12:07:44 2026     /opt/homebrew/Cellar/node/26.5.0/bin/node /Users/terry/git/stock-info/scripts/local-job-worker.mjs
28278  8656 Sun Aug  9 12:10:50 2026     /bin/zsh -c node scripts/audit-local-runtime.mjs --output docs/runtime-audits/local-runtime-final-2026-08-09.md\012curl -fsS http://127.0.0.1:8000/api/health\012[ ! -e .wrangler/state ] && printf 'repo wrangler state absent\n'
```

### Task states

```json
{
  "information_processing_jobs": [
    {
      "status": "completed",
      "count": 2
    }
  ],
  "knowledge_processing_runs": [],
  "research_operating_analysis_jobs": [],
  "research_web_search_package_jobs": [
    {
      "status": "completed",
      "count": 1
    }
  ],
  "sync_jobs": [
    {
      "status": "succeeded",
      "count": 8
    }
  ]
}
```

## Decision

- Node SQLite: migrate: canonical local Node SQLite data source.
- Miniflare: archive: preserve .wrangler/state backup until P6 confirms no local command accesses it; do not import historical Miniflare rows into Node SQLite.
