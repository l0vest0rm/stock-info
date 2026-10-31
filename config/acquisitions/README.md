# Embedded acquisition

Place reviewed schema_version: 2 flow YAML here, or set LOCAL_ACQUISITION_CONFIG_DIR.
No sources, credentials or active targets are seeded. Sub2Me's reviewed flow YAML
can be reused; session material must be provisioned for this host separately.

Register a paused task using `./start-rust.sh --acquisition put --file task.json`:

```json
{"name":"my-news","flow":"my-flow","settings":{"interval":"5m"},"targets":[{"url":"https://example.com/news"}]}
```

Enable explicitly: `./start-rust.sh --acquisition status --task my-news --status active`.
List: `./start-rust.sh --acquisition list`.
One round: `./start-rust.sh --acquisition run --task my-news` (honors paused status).
Normal server startup schedules active tasks in-process. LOCAL_SCHEDULER=0 stops
all collection scheduling too. Three control tables store tasks, runs and sessions in LOCAL_DB_PATH. Results
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
Unfinished run records are not proof that a process is still running; next-run
time is not exposed because the scheduler tracks deadlines in memory.

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
