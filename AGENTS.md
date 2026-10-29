# Stock Info Instructions

## Runtime Model

- This checkout is local-only. Cloudflare deployment is retired; do not restore
  Worker deployment, remote migrations or automatic report publication.
- Full business functionality currently runs in the transitional Node runtime
  through `./start-local.sh`, default URL `http://127.0.0.1:8000`.
- The Rust replacement is in `backend/`, launched with `./start-rust.sh`.
  It is NOT feature-complete: see `docs/local-rust-migration.md` for gates.
  Do not switch the default runtime or delete TypeScript business modules until
  their Rust replacements pass contract and behavioral acceptance. No Node
  proxy, subprocess or embedded JS is a completed Rust migration.

## LLM Runtime Boundary

- Model calls are allowed only in the explicit local runtime with
  `LLM_RUNTIME=local`. Local-only does not mean offline: authorized providers
  and taskd still require network connectivity and credentials.
- Keep credentials in ignored local stores; never put them in config or logs.

## Local Workflow

- `./start-local.sh` builds assets/prompts, typechecks, migrates local SQLite,
  starts the full transitional Node runtime and waits for health.
- `./start-rust.sh` builds web assets and starts the partial Rust backend;
  it never stops an existing service. Use an unused PORT for migration tests.
- `npm run check:rust` runs formatting, clippy and isolated Rust regressions.
- `npm run test:basic` remains the full business acceptance baseline against a
  running local API. Never remove or weaken it to make partial Rust pass.
- Assets are served from `web/dist`. Rebuild before page acceptance.
- Cron expressions are in `config/app/local-runtime.json`, timezone UTC.
- SQLite stays at `LOCAL_DB_PATH`, or `LOCAL_DATA_DIR/stock-info.sqlite`
  (default `data/local/stock-info.sqlite`); both migrators preserve the sorted
  historical migration/user_version protocol. Never add a migration table.

## Verification

- Prove real API/page behavior first, then module checks. Isolated Rust tests
  do not prove valuation, provider, scheduler or private-portfolio parity.
- Inspect stored content/API payload before assuming a renderer issue.
- Separate local processing, local SQLite visibility and local object lifecycle.
- Never migrate or drop tables in the user's real database merely to test.
- No cloud resource was deleted or undeployed by the local-only code change.

## Change Boundaries

- Preserve durable ledger namespaces, local data and active sessions.
- TypeScript/Cloudflare type definitions and historical remote maintenance
  scripts are transitional source, not a supported deployment workflow.

## Schema Change Boundaries

- Do not add a new database table directly in this repo.
- If a new table is truly required, stop and get explicit user approval before adding any migration with `CREATE TABLE`.
- Any approved new-table change must also update the repository's schema guard allowlist and automated test coverage so unapproved future table additions fail in CI/local verification.

## Market Data Source Boundaries

- Stock K-line data must use Xueqiu only. Do not add Eastmoney, Tencent, Yahoo, or other stock K-line fallbacks for A-shares, Hong Kong stocks, U.S. stocks, or indices.
- Fund net-value history remains Eastmoney-only because it is not a stock K-line source.
- Xueqiu requests require `XUEQIU_COOKIE`, refreshed locally through CDP and written to the ignored local credential store (never commit the Cookie). When the cookie is unavailable or rejected, surface the failure rather than silently switching data sources.
- Yahoo is allowed for U.S. stock options data and U.S. financial-statement collection. Local U.S. financial-statement requests must use the configured Yahoo proxy; production may access Yahoo finance directly through the unified HTTP client and cache. Do not use Yahoo for stock K-lines, search, Hong Kong financial statements, or other market data.

## Observation Pool Runtime

- The dashboard is a rolling read model, not a point-in-time backtest dataset.
  `shared/valuation-dashboard.ts` owns its API contract. Each row carries its
  computation ID, dependency revision and calculation time; source dates remain
  separate. Do not describe the newest row timestamp as a common valuation date.
- `valuation-screen-cache.ts` owns all dashboard writes. GET is read-only;
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
  `observation-research.ts` in application owns immutable research versions and
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
- `active-portfolio.ts` in application is the sole portfolio ledger writer.
  It appends versioned records to existing `kv_cache`, namespace
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
