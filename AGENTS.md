# Stock Info Instructions

## Runtime Model

- This checkout is local-only. Cloudflare deployment is retired; do not restore
  Worker deployment, remote migrations or automatic report publication.
- The backend is the native Rust application in `backend/`, launched through
  `./start-local.sh` (alias `./start-rust.sh`). API/page URL defaults to
  `http://127.0.0.1:8000`; the local content listener defaults to port 8788.
- Node is frontend/build tooling, test orchestration and supported offline
  analysis, not a backend runtime or fallback. The retired backend `src/`
  tree and backend JavaScript/TypeScript implementations are removed. Do not
  restore them, a Node business proxy/subprocess, or embedded JS.
- Original-backend expected results are frozen complete JSON fixtures with
  provenance in `backend/tests/fixtures/`; Rust tests consume them without Node.
  Never regenerate expected outputs from the Rust implementation under test.
- Frontend contracts belong in `shared/`; frontend-only validation belongs in
  the web domain. Do not recreate a second backend in shared TypeScript.
- See `docs/local-rust-migration.md` for implementation and acceptance scope;
  healthy listeners alone do not prove business/provider parity.

## LLM Runtime Boundary

- Model calls are allowed only in the explicit local runtime with
  `LLM_RUNTIME=local`. Local-only does not mean offline: authorized providers
  and taskd still require network connectivity and credentials.
- Keep credentials in ignored local stores; never put them in config or logs.

## Local Workflow

- `./start-local.sh` delegates to `./start-rust.sh`: builds prompts/web assets
  and the locked Rust application, then execs the native binary. The binary
  acquires both listeners before migrating SQLite. Before building, server
  startup sends SIGTERM only to this checkout's old native listeners and waits
  up to 30 seconds for exit; unrelated listeners and CLI commands are untouched.
  The binary itself still fails on occupied ports without opening its database.
- Use unused API/content ports and isolated data/object directories for tests.
  Typechecks are separate gates, not implicit startup checks.
- `npm run check:rust` runs formatting, clippy and isolated Rust regressions.
- `npm run test:basic` remains the full business acceptance baseline against a
  running local API. Never remove or weaken its business assertions to obtain a pass.
- Assets are served from `web/dist`. Rebuild before page acceptance.
- Cron expressions are in `config/app/local-runtime.json`, timezone UTC.
- SQLite stays at `LOCAL_DB_PATH`, or `LOCAL_DATA_DIR/stock-info.sqlite`
  (default `data/local/stock-info.sqlite`); the Rust migrator preserves the
  sorted historical migration/user_version protocol. Never add a migration table.

## Verification

- Prove real API/page behavior first, then module checks. Isolated Rust tests
  do not prove valuation, provider, scheduler or private-portfolio parity.
- Inspect stored content/API payload before assuming a renderer issue.
- Separate local processing, local SQLite visibility and local object lifecycle.
- Never migrate or drop tables in the user's real database merely to test.
- No cloud resource was deleted or undeployed by the local-only code change.

## Change Boundaries

- Preserve durable ledger namespaces, local data and active sessions.
- Cloud deployment, remote-maintenance code and its runtime dependencies are
  removed. Historical commits remain the source-history reference, not a
  supported deployment workflow. Do not delete `.dev.vars`, local `.wrangler`
  data, reports or other durable user data merely because old cloud code is gone.
- Supported offline analysis may call the native `--analysis-json` bridge.
  Keep that bridge stateless: pure JSON input/output, no SQLite, providers,
  credentials or listeners. It is not permission to restore Node business code.
- PDF conversion/cleaning may use the separately installed Python/PyMuPDF tools;
  this is not a Node backend. Missing reviewed cleaners must fail explicitly,
  never silently omit cleaning. See README for installation/discovery boundaries.

## Schema Change Boundaries

- Do not add a new database table directly in this repo.
- If a new table is truly required, stop and get explicit user approval before adding any migration with `CREATE TABLE`.
- Any approved new-table change must also update the repository's schema guard allowlist and automated test coverage so unapproved future table additions fail in CI/local verification.

## Market Data Source Boundaries

- Stock K-line data must use Xueqiu only. Do not add Eastmoney, Tencent, Yahoo, or other stock K-line fallbacks for A-shares, Hong Kong stocks, U.S. stocks, or indices.
- Fund net-value history remains Eastmoney-only because it is not a stock K-line source.
- Xueqiu requests require `XUEQIU_COOKIE`, refreshed locally through CDP and written to the ignored local credential store (never commit the Cookie). When the cookie is unavailable or rejected, surface the failure rather than silently switching data sources.
- Yahoo is allowed for U.S. stock options data and U.S. financial-statement collection. Local U.S. financial-statement requests must use the configured Yahoo proxy through the unified HTTP client and cache. Do not use Yahoo for stock K-lines, search, Hong Kong financial statements, or other market data.

## Observation Pool Runtime

- The dashboard is a rolling read model, not a point-in-time backtest dataset.
  `shared/valuation-dashboard.ts` owns its API contract. Each row carries its
  computation ID, dependency revision and calculation time; source dates remain
  separate. Do not describe the newest row timestamp as a common valuation date.
- `backend/src/dashboard.rs` and its submodules own all dashboard writes.
  Frozen original-backend fixtures preserve prior expectations; GET is read-only;
  POST refresh performs at most two due securities, with fresh results reused.
  The one-minute cron processes at most twelve due securities per invocation;
  shared SQLite leases cap dashboard computations at two across callers.
  Closing a page does not stop cron. Browser polling never schedules securities.
- Financial statements retain their existing source freshness policy; only
  quote refresh bypasses HTTP cache. Do not force all financial sources on page
  visits. No new tables or LLM work are required for the dashboard.
- `npm run build:prompts` also generates the deterministic valuation dependency
  revision. Run it after source/config changes; `node scripts/build-valuation-revision.mjs
  --check` verifies it. The supported local workflows run this step.
- `npm run test:basic` starts with isolated SQLite cache/lease regression checks,
  then validates the running local API. Rust cron behavior and provider quotas still require
  separate runtime acceptance.

## Observation Research Ledger

- `shared/observation-research.ts` owns the research editor/history contract.
  `backend/src/observation.rs` owns runtime immutable research versions and
  outcomes in existing `kv_cache`, namespace `observation-ledger-v1`, with null
  expiry. Treat this namespace as durable records, not disposable cache.
- Only the dashboard writer appends daily observation cohorts. GET stays
  read-only. Research versions invalidate cached results; the current dashboard
  schema is v5. Local-only editor routes enforce same-origin and loopback Host.
- Industry inputs are manually sourced/reviewed facts, not fabricated provider
  coverage. Missing evidence cannot pass. Scenario outputs are conditional
  earnings/dividend/multiple models, not DCF or consensus forecasts.
- Historical evaluation starts after actual capture, preserves exclusions and
  policy versions, and never backfills past cohorts. Matured outcomes are frozen.
  New functionality does not imply mature forward performance or deployment.

## Private Active Portfolio

- `shared/active-portfolio.ts` owns the private diversified-active portfolio
  contract. The maximum is 39 distinct securities across accounts, not a target
  count; company concentration merges known multiple listings by company ID.
- `backend/src/portfolio.rs` and its submodules are the sole runtime portfolio
  ledger writer. Contract fixtures and native tests preserve arithmetic,
  private-route, immutable-history and concurrency requirements.
  The writer appends versioned records to existing `kv_cache`, namespace
  `private-active-portfolio-v1`, with null expiry and optimistic concurrency.
  This namespace is durable private data: never publish, evict as cache, or
  embed it into the public universe/research configuration or web bundle.
- All portfolio reads/writes are local, loopback Host and same-origin only.
  GET is read-only. The UI polls existing research; it never schedules providers.
  Never expose private portfolio records beyond the local runtime.
- Snapshot prices, quantities, cash and FX are explicitly user-reconciled inputs,
  not live quotes. Missing any price/FX leaves NAV and all weights unavailable.
  Currency must match the security market. Cash is included in weight denominators.
- Site tasks are review requests, never trades. Decisions retain underlying risk
  and missing-data warnings; semantic evidence changes/new snapshots reopen tasks.
  Acknowledgement is not evidence that an investment thesis is valid or a trade
  executed. External push is not enabled; no portfolio return claims are made.
- `npm run test:basic` includes isolated portfolio arithmetic, private-route,
  immutable-history and concurrent-write regressions. See
  `docs/active-portfolio-workflow.md` for supported scope and remaining gates.

- Portfolio what-if proposals are separate from actual snapshots. Comparisons
  lock original rules/date/FX/price basis; confirmations record a human decision,
  not a fill. Reject confirmation with unbalanced funds, unknown fees/valuation,
  >39 securities or stale snapshots. Never copy a proposal into actual holdings
  without separately reconciled user input. Company dynamic information reads
  existing entity-linked feed records (extraction integrity is not factual verification), not a new extraction scheduler.

## Embedded Acquisition

- `backend/src/acquisition_runtime.rs` embeds the shared Rust crate at
  `../sub2me/crates/acquisition`; there is no acquisition subprocess or new DB.
- `0149_acquisition.sql` is the acquisition-table addition explicitly approved
  in the 2026-10-31 embedding request. Future schema additions still require
  approval, the schema guard allowlist and regression coverage. The host's
  sorted migration/user_version protocol remains authoritative.
- Flow YAML lives in `config/acquisitions` or `LOCAL_ACQUISITION_CONFIG_DIR`.
  `--acquisition list|put|status|run|session-import|import-sub2me` manages host-local tasks;
  new tasks are paused. Normal server startup schedules active tasks in-process;
  `LOCAL_SCHEDULER=0` disables collection too. No credentials/tasks are seeded.
- `0150_compact_acquisition.sql` is the compact-schema refactor approved in the
  same embedding discussion: only acquisition_tasks/runs/sessions remain. The
  host owns migration ordering; legacy embedded records are moved to knowledge_docs
  before redundant tables are dropped. Back up real data before explicit cutover.
- `KnowledgeStorage` implements replacement `RecordStorage`, not a post-write
  projection: raw/canonical content/tags use existing knowledge_docs with inline
  bodies; scope checkpoint and business rows commit together. No shadow result
  table, automatic publication, LLM invocation or relevance-gate bypass.
- Explicit import-sub2me reads a stopped source DB and imports only acquisition
  tasks/targets, bound sessions/caches and checkpoints, preserving status. It never
  copies article/editorial/publication queues or silently runs during startup.
- The shared native SQLite dependency chain pins rusqlite 0.41.1 with bundled
  SQLite 3.54.1 (2026-10-31), including llm-client and CEA. Keep consumers aligned;
  use checked SQL integer conversions rather than binding platform-sized usize.
- `backend/tests/acquisition_runtime.rs` verifies schema equality, host migration
  ownership, real loopback HTTP collection, scheduler execution, restart dedupe,
  paused registration and invalid-target rollback in isolated databases.
