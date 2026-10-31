# Embedded acquisition

Place reviewed schema_version: 2 flow YAML here, or set LOCAL_ACQUISITION_CONFIG_DIR.
No sources, credentials or active targets are seeded. Sub2Me's reviewed flow YAML
can be reused; session material must be provisioned for this host separately.

Register a paused task using `./start-rust.sh --acquisition put --file task.json`:

```json
{"name":"my-news","flow":"my-flow","settings":{"interval":"30m"},"targets":[{"url":"https://example.com/news"}]}
```

Enable explicitly: `./start-rust.sh --acquisition status --task my-news --status active`.
List: `./start-rust.sh --acquisition list`.
One round: `./start-rust.sh --acquisition run --task my-news` (honors paused status).
Normal server startup schedules active tasks in-process. LOCAL_SCHEDULER=0 stops
all collection scheduling too. The default period is 30 minutes when omitted.
The status page lets you save each task's period in integer minutes (1–10080),
without restarting. Existing explicitly configured periods are preserved.
Scheduling uses the last persisted attempt's **start** plus the current period,
including failed/interrupted attempts; imported completion time is a fallback
when no attempt record exists. Restart runs only never-run or overdue tasks,
coalescing missed periods into one round. Changing a period recalculates from
that same start, not from page load or service startup.

Three control tables store tasks, runs and sessions in LOCAL_DB_PATH. Results
(raw/canonical content and tags) go directly to existing knowledge_docs, with
inline bodies and acquisition provenance. No acquisition_records table is used.
This does not bypass investment/relevance gates or trigger model work/publication.

Import a private HTTP cookie jar with `./start-rust.sh --acquisition session-import --task my-news --file /absolute/private-cookies.json`. The file must be owner-only and the source must validate it; login is not automated.

## Status page

`/acquisitions.html` (navigation: 采集任务) polls the read-only
`GET /api/local/acquisitions` every 15 seconds while visible. The API uses the
existing acquisition tables and returns task lifecycle, configured interval,
enabled target count, latest attempt start/end/result/new-record count, last
successful completion and total stored records. Times render in Asia/Shanghai.
It does not run tasks or trigger processing/publication. Raw errors, session
material, proxy settings and collected payloads are deliberately excluded.
Unfinished run records are not proof that a process is still running. The page
shows the next due time for active tasks (not a guaranteed execution time:
concurrency and running work can delay it). PUT
`/api/local/acquisitions/:id/interval` accepts `{"interval_minutes":30}`;
loopback Host and an explicit same-origin Origin are required. This mutation
changes only config_json.interval; it neither activates tasks nor starts work.
GET remains read-only and never returns session/proxy material.

The six reviewed flow YAML files are copied from `../sub2me/configs/acquisitions`.
They do not automatically register tasks or import accounts. When explicitly
reusing an installed Sub2Me setup, use its service-configured database (not an
assumed repository data file), preserve task-specific targets/settings, and
provision bound credentials only into the ignored local SQLite store. Do not
copy publication queues, subscriptions or unrelated application tables. Newly
registered tasks remain paused until explicitly enabled for a real run.

## Explicit local handoff

`./start-rust.sh --acquisition import-sub2me --file /absolute/source.db` copies
source acquisition task definitions, targets, bound credentials/caches and
checkpoints, preserving active/paused status. Source is read-only. Stop the source
collector and destination scheduler first, and back up the destination DB. This
is an operator-triggered handoff, not ongoing sync or task seeding. Historical
source results and publication tasks/queues are not copied. Do not commit session
material. The installed Sub2Me database path comes from its launchd configuration.

`0150_compact_acquisition.sql` preserves earlier embedded data while reducing the
final acquisition schema to three tables. Existing legacy results migrate into
knowledge_docs before redundant tables are dropped. A failing migration rolls
back; the host remains responsible for sorted migration/user_version ordering.

## App-capture prerequisite

`start-rust.sh` sources the optional **trusted local shell configuration**
`data/local/acquisition-runtime.env` (or LOCAL_ACQUISITION_RUNTIME_ENV). Keep it
owner-only; do not source downloaded files. Configure APP_CAPTURE_HOST with the
installed SDK host executable and APP_CAPTURE_STATE_DIR with the existing SDK
runtime directory when reusing active capture sessions. Explicit caller env
should take precedence. This does not stop/reset a shared capture host or change
system proxy/certificate permissions. Build the host from
`../mitmproxy/app-capture-sdk/Cargo.toml --bin app-capture-host` if not installed.

The standalone installer builds the SDK helper and updates managed
`bin/app-capture-host` on every install; it is not a first-install-only data file.
The installed launcher selects that helper before loading legacy conditional
local defaults. Explicit caller overrides remain supported. The SDK rejects
resolved `/Volumes/` executable/state paths, starts helpers with an internal
working directory, and checks the actual macOS socket peer's executable before
reusing it. An external-disk legacy host is rejected, not killed or replaced:
coordinate its exit with other consumers after active leases finish. A socket
connection alone is not evidence that the old host is safe to reuse.
