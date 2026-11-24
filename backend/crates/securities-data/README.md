# securities-data

Native Rust acquisition and processing shared by stock-info and consumers such
as trade. This is a library, not a stock-info HTTP client or backend runtime.

## Why one crate

Statements and research reports currently share security identifiers, JSON
contracts, cache/HTTP policies and financial forecast semantics. One crate with
separate `finance`, `notices` and `reports` modules avoids a third infrastructure crate or
mutual dependencies. No stock-info, SQLite, Axum, CEA, or LLM-client dependency is
pulled into consumers. PDF parsing remains a library dependency.

## Consume from trade

For a package under `trade/crates/<package>/Cargo.toml`:

```toml
[dependencies]
securities-data = { path = "../../../stock-info/backend/crates/securities-data" }
```

Adjust relative paths for your package directory. The crate is self-contained;
its own config assets travel with it. It does not read stock-info's root, data,
credentials, runtime, database or listening port.

Implement `securities_data::Runtime` using the consumer's HTTP/cache/object-store
services. See `tests/runtime_contract.rs` for a complete in-memory implementation
that acquires and processes data using injected transport responses. Stock-info's
production adapter is `backend/src/securities_runtime.rs`. Do not share its
`AppState`, DB, private ledger, or installation with another application.

```rust,ignore
use securities_data::{finance, reports};

let (source, rows) = finance::providers::load(&runtime, "600036.SH", "income").await?;
let quarters = finance::series::quarterly_series("600036.SH", &rows, 12);
let reports = reports::sources::eastmoney_reports(&runtime, "600036.SH", 1, 20).await?;
let body = reports::sources::eastmoney_pdf_text(&runtime, "AP123456789012").await?;
```

Check the signatures for series functions: the normalized financial row JSON is
the existing source-preserving contract, not an inferred zero-filled model.
`providers::fetch_cn/fetch_hk/fetch_us` acquire primary-source rows directly;
`providers::load` adds snapshot freshness/reuse and provisional merging.
`series` contains fiscal-calendar, annual/quarterly/TTM arithmetic. Reports expose
Eastmoney/Sina list acquisition, GBK decoding, source mapping, HTML/PDF extraction
(first 30 PDF pages), forecast parsing, deduplication and aggregation via `domain`.

`reports::analysis::analyze` accepts `AnalysisOptions` and an async completion
callback. The host supplies the reviewed system/user prompt templates, model,
explicit `runtime: "local"`, and its own direct LLM client. The library formats
and truncates content (12,000 characters), validates parsed forecasts and keeps
`rawResponseText`. The callback owns credentials, protocol, routing and streaming.
An empty/non-local request never invokes the callback; provider errors propagate.
Stock-info continues to own its existing reviewed prompt files and provenance.

## Dividend history and yield

`finance::dividends` also owns dividend acquisition and processing:

- `share_additional(&runtime, code)` fetches the financing side of the stock-info
  dividend/financing page: Eastmoney additional share issues, newest notice first
  (first 100, 24-hour cache). Returns raw share counts, net proceeds, issue price,
  method and dates; no unit conversion or K-line lookup. Not total financing,
  IPO proceeds, rights offerings, debt issuance or margin trading.
- `fetch_history(&runtime, code)` fetches raw Eastmoney decisions with reporting
  periods, sorted by announcement ascending. `fetch_share_bonus_rows` preserves
  the legacy newest-first share-bonus provider query. Both retain the existing
  first-page, 100-row limit and 24-hour HTTP cache; this is not an all-pages archive.
- `share_bonuses_from_rows(raw, changes)` normalizes cash/bonus-share/transfer
  plans per share and computes total cash using the event-date share basis.
  Changes must be newest-first `changeDate`/`totalShares` rows.
- `dividend_yield_from_rows(raw, bars)` is pure announcement-date series/rolling
  four-reporting-quarter arithmetic. Bars must be ascending, unadjusted prices.
- `share_changes(&runtime, code)` fetches/normalizes Eastmoney equity history
  (newest first, existing 5,000-row limit). `share_changes_from_rows` is pure.
  Empty history remains empty; no current-share estimate or price fallback.
- `share_bonuses(&runtime, code)` composes Eastmoney dividends and Eastmoney
  share history. It needs only the existing `Runtime` HTTP/cache methods.
- `dividend_yield(&runtime, code, bars)` fetches dividend decisions and uses
  explicit price rows supplied by the caller. It never acquires K-lines and has
  no market-provider trait or cookie dependency. The host application alone
  decides whether/how to acquire prices for its existing historical-yield page.

```rust,ignore
use securities_data::finance::dividends;
let history = dividends::fetch_history(&runtime, "600036.SH").await?;
let shares = dividends::share_changes(&runtime, "600036.SH").await?;
let bonuses = dividends::share_bonuses(&runtime, "600036.SH").await?;
let yield_series = dividends::dividend_yield_from_rows(&history, &caller_prices);
```

Legacy behavior is preserved, including zero `bonusTotal` for missing shares,
empty zero-valued yields for absent rows/bars and non-CN composed yield requests,
and explicit provider errors. These are compatibility outputs, not evidence of
zero economic dividends or newly added Hong Kong/U.S. dividend coverage.

## Boundaries and policy

- Runtime methods must preserve HTTP proxy, timeout, size and concurrency policies.
  Yahoo is **only** a U.S. financial-statement source here and must use the
  consumer's configured Yahoo proxy/cache. There is no stock K-line acquisition.
- Financial source selection remains CN/HK Eastmoney, U.S. Yahoo; failures are
  returned, never switched to another provider. Existing cache keys, absolute
  expiration and `r2` legacy snapshot-source marker remain compatible (the marker
  does not imply remote R2 access).
- `Runtime::config` supplies `shared/finance-mappings.json` bank/security/insurance
  classification. Consumers provide their own reviewed configuration.
- JSON/cache/object writes are explicit through the host. SQL/migrations and
  optional malformed-cache handling belong to the adapter; no new tables.
- Stock-info's routes, public read-model/valuation assembly, durable ingestion
  checkpoints, knowledge/news source pools, browser/CEA report discovery,
  extraction dedupe/quota, and publication/review workflows stay in the host.
  These application workflows are not automatically enabled in trade.
- trade integration is opt-in: this change does not modify trade's UI, runtime,
  private accounts or trading behavior.

## Verification

From stock-info:

```sh
cargo test --locked --manifest-path backend/Cargo.toml -p securities-data
npm run check:rust
```

Frozen original-backend fixtures remain in the host tests and are not regenerated.

## Daily valuation observations

`finance::valuations::{history, Metric, closing_prices}` acquires Eastmoney
`RPT_VALUEANALYSIS_DET` daily PE_TTM / PB_MRQ observations through host Runtime.
`history(runtime, qualified_code, Metric::Pb, from, to)` returns ascending
`date/value/status/reportDate` points. Non-positive ratios and missing values are
gaps; extreme positives stay intact. Source report dates are unavailable: this is
not a certified point-in-time dataset. The source is bounded to 20×500 rows,
checks pagination completeness/identity/dates/duplicates and never falls back.
`closing_prices` supplies explicit unadjusted date/close inputs from the same
valuation observations for existing dividend arithmetic: no OHLC, K-line provider,
Cookie, private store or implicit market fallback. The existing dividend algorithm,
100-row dividend source limit and legacy behavior are unchanged. Callers must
label its yield as announcement-plan/latest-four-reporting-quarter yield, not
paid-dividend TTM, and must not turn an empty summary zero into historical points.

## Company notices and broker report lists

- `notices::company_notices(&runtime, code, page, page_size, category, research)`
  returns provider IDs, titles, dates, types and PDF URLs. Ordinary SH/SZ/BJ/HK
  notices use CNINFO; U.S. notices use Eastmoney. `research=true` means **SZ
  investor-relations disclosures**, not analyst reports. Other markets return
  an empty list for that mode. `notices::periodic_reports` queries the first
  page of each of four CNINFO filing categories, not the whole archive.
- For notices, additionally implement `notices::NoticeRuntime::cached_post_json`
  with the host's HTTP policy and a cache keyed by method, URL, headers and body.
  Existing finance and broker-report consumers need only `Runtime`.
- `reports::list::recent(&runtime, "300308.SZ")` fetches and deduplicates the
  first Eastmoney page (up to 100 rows) and first Sina page of A-share broker
  reports. Eastmoney errors propagate; Sina is optional. Dated reports have a
  90-day cutoff; undated rows are retained. This call does not run a model,
  open a browser or query stock-info. For provider-specific pagination use
  `reports::sources::{eastmoney_reports,sina_reports}`.
