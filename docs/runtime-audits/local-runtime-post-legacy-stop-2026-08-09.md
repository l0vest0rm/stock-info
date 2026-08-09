# Local Node runtime baseline audit

Collected: 2026-08-09T03:12:36.548Z

Commands: `node scripts/audit-local-runtime.mjs --output <report.md>` ; `tar -tzf <retired-state.tar.gz>`

- Node SQLite: `/Users/terry/git/stock-info/data/local/stock-info.sqlite` (20316160 bytes, 170 tables)
- Canonical historical Miniflare D1: `/Users/terry/git/stock-info/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/49967060aabe15e5582d46757e42915ead8b493802c609f5587e3e3a8fb65f20.sqlite`
- Machine-readable detail: `/Users/terry/git/stock-info/docs/runtime-audits/local-runtime-post-legacy-stop-2026-08-09.json`
- The pre-retirement Miniflare backup is `data/local/retired-wrangler-state/wrangler-state-20260809T103800+0800.tar.gz`; its checksum and readability evidence are recorded in the baseline report.

## Scoped database comparison

| Scope | Node SQLite | Miniflare D1 | Node-only primary keys | Miniflare-only primary keys |
| --- | --- | --- | ---: | ---: |
| securities | 5 rows; max updated_at=1786242113682 | 1506 rows; max updated_at=1786237356487 | 0 | 1501 |
| kline | absent | absent | n/a | n/a |
| knowledge documents | 16 rows; max published_at=2026-08-09T02:41:25.000Z, fetched_at=2026-08-09T02:45:00.529Z, event_time=2026-08-09T02:41:25.000Z, updated_at=1786243501396, sort_time=2026-08-09T02:41:25.000Z | 37866 rows; max published_at=2026-08-09T01:47:05.000Z, fetched_at=2026-08-09T01:54:40.858Z, event_time=2026-08-09T01:47:05.000Z, updated_at=1786240481823, sort_time=2026-08-09T01:47:05.000Z | 16 | 37866 |
| knowledge processing | 2 rows; max created_at=1786243071948, updated_at=1786243071948 | 18968 rows; max created_at=1786238878200, updated_at=1786238878200 | 2 | 18968 |
| research web search | 0 rows; max created_at=null, started_at=null, completed_at=null, updated_at=null | 5 rows; max created_at=1786069631071, started_at=1786087442805, completed_at=1786087713474, updated_at=1786087713474 | 0 | 5 |
| research operating analysis | 0 rows; max created_at=null, started_at=null, completed_at=null, updated_at=null, partial_updated_at=null | 21 rows; max created_at=1786235829112, started_at=1786239670301, completed_at=1786241037174, updated_at=1786241037174, partial_updated_at=1786195167970 | 0 | 21 |
| macro | 1 rows; max updated_at=1786242111840 | 25 rows; max updated_at=1786238220003 | 0 | 24 |
| situation | 1 rows; max occurred_at=1786241207000, first_seen_at=1786243200003, last_seen_at=1786243200003, created_at=1786243200003, updated_at=1786243200003 | 1077 rows; max occurred_at=1786234803000, first_seen_at=1786235400003, last_seen_at=1786235400003, created_at=1786235400003, updated_at=1786235400003 | 1 | 1077 |

The JSON report retains each scoped schema and every table's row count and maximum date-like field. Tables without compatible declared primary keys are deliberately not inferred equal.

## Runtime baseline

### Listeners

```text
none
```

### Repository-related processes

```text
  123     1 Wed Aug  5 07:30:27 2026     /usr/libexec/watchdogd
```

### Task states

```json
{
  "information_processing_jobs": [
    {
      "status": "queued",
      "count": 2
    }
  ],
  "knowledge_processing_runs": [],
  "research_operating_analysis_jobs": [],
  "research_web_search_package_jobs": [],
  "sync_jobs": [
    {
      "status": "succeeded",
      "count": 2
    }
  ]
}
```

## Decision

- Node SQLite: migrate: canonical local Node SQLite data source.
- Miniflare: archive: preserve .wrangler/state backup until P6 confirms no local command accesses it; do not import historical Miniflare rows into Node SQLite.
