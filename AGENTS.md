# Stock Info Instructions

## Runtime Model

- Treat this repo as a Cloudflare Worker project in production and a Node runtime project in local development.
- Local development should default to `./start-local.sh`, which starts the Node runtime without Wrangler.
- The default local URL is `http://127.0.0.1:8000`.
- Production deployment and verification must be treated separately from the Node local runtime.

## LLM Runtime Boundary

- Remote LLM calls are allowed only from the local Node development runtime, explicitly marked with `LLM_RUNTIME=local` by the supported local launch scripts.
- Production must keep `LLM_RUNTIME=production`; never add an LLM fallback, exception, or production override, even when model credentials are present.

## Local Workflow

- Use `./start-local.sh` for the standard local loop because it already builds `web/dist`, typechecks, applies local SQLite migrations, starts the Node runtime, and waits for `/api/health`.
- The only retained automated test is `npm run test:basic` against a running local Node API.
- For browser-facing changes, remember that static assets are served from `web/dist`; stale build output is a common false negative.

## Production Workflow

- Production runs on Cloudflare, so local success is not the same as production success.
- For production-affecting work, verify the correct layer explicitly: `wrangler` config, remote D1 migrations, deploy script behavior, and the real production health/API URL.
- Do not describe the production runtime as a local long-lived service.

## Verification

- Verify at the highest realistic layer first: real page/API behavior on the target environment, then module-level checks.
- When a page looks wrong, inspect the real stored content shape or API payload before assuming the frontend renderer is the only issue.
- When converted knowledge content misroutes, inspect the API response fields that drive the frontend branch, especially access-method style routing.
- For knowledge import issues, separate local processing, local cache, remote D1 visibility, and remote R2 lifecycle.

## Codex Proof

- Default local proof path: `./start-local.sh`, then `GET http://127.0.0.1:8000/api/health`.
- For served page or routing changes, verify the affected page manually and run `npm run test:basic` for the retained API baseline.
- For remote knowledge visibility, prove through `/api/knowledge/docs` or remote D1 checks; prepare/upload logs alone do not prove the page can see the docs.

## Change Boundaries

- Keep Cloudflare-specific configuration, bindings, migrations, and deploy logic explicit.
- Do not add local-only shortcuts that obscure the Worker/D1 production contract.

## Schema Change Boundaries

- Do not add a new database table directly in this repo.
- If a new table is truly required, stop and get explicit user approval before adding any migration with `CREATE TABLE`.
- Any approved new-table change must also update the repository's schema guard allowlist and automated test coverage so unapproved future table additions fail in CI/local verification.

## Market Data Source Boundaries

- Stock K-line data must use Xueqiu only. Do not add Eastmoney, Tencent, Yahoo, or other stock K-line fallbacks for A-shares, Hong Kong stocks, U.S. stocks, or indices.
- Fund net-value history remains Eastmoney-only because it is not a stock K-line source.
- Xueqiu requests require `XUEQIU_COOKIE`, refreshed locally through CDP and written to the ignored local credential store plus production Worker secret before deployment (never commit the Cookie in wrangler vars). When the cookie is unavailable or rejected, surface the failure rather than silently switching data sources.
- Yahoo is allowed for U.S. stock options data and U.S. financial-statement collection. Local U.S. financial-statement requests must use the configured Yahoo proxy; production may access Yahoo finance directly through the unified HTTP client and cache. Do not use Yahoo for stock K-lines, search, Hong Kong financial statements, or other market data.

## Observation Pool Runtime

- The dashboard is a rolling read model, not a point-in-time backtest dataset.
  `shared/valuation-dashboard.ts` owns its API contract. Each row carries its
  computation ID, dependency revision and calculation time; source dates remain
  separate. Do not describe the newest row timestamp as a common valuation date.
- `valuation-screen-cache.ts` owns all dashboard writes. GET is read-only;
  POST refresh performs at most two due securities, with fresh results reused.
  The one-minute cron processes at most twelve due securities per invocation;
  shared SQLite/D1 leases cap dashboard computations at two across callers.
  Closing a page does not stop cron. Browser polling never schedules securities.
- Financial statements retain their existing source freshness policy; only
  quote refresh bypasses HTTP cache. Do not force all financial sources on page
  visits. No new tables or LLM work are required for the dashboard.
- `npm run build:prompts` also generates the deterministic valuation dependency
  revision. Run it after source/config changes; `node scripts/build-valuation-revision.mjs
  --check` verifies it. The supported local/deploy workflows run this step.
- `npm run test:basic` starts with isolated SQLite cache/lease regression checks,
  then validates the running Node API. Production cron execution, D1 behavior
  and provider quotas still require separate deployed-environment acceptance.

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
- All portfolio reads/writes are local Node, loopback Host and same-origin only.
  GET is read-only. The UI polls existing research; it never schedules providers.
  Production does not expose private portfolio records or execute remote LLMs.
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
