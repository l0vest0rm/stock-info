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
- Prefer `npm run test:smoke:pages` when the change affects served pages or routing.
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
- For served page or routing changes, prefer `npm run test:smoke:pages` when it exercises the changed behavior.
- For remote knowledge visibility, prove through `/api/knowledge/docs` or remote D1 checks; prepare/upload logs alone do not prove the page can see the docs.

## Change Boundaries

- Keep Cloudflare-specific configuration, bindings, migrations, and deploy logic explicit.
- Do not add local-only shortcuts that obscure the Worker/D1 production contract.

## Market Data Source Boundaries

- Stock K-line data must use Xueqiu only. Do not add Eastmoney, Tencent, Yahoo, or other stock K-line fallbacks for A-shares, Hong Kong stocks, U.S. stocks, or indices.
- Fund net-value history remains Eastmoney-only because it is not a stock K-line source.
- Xueqiu requests require `XUEQIU_COOKIE`, refreshed locally through CDP and written to local plus production Worker variables before deployment. When the cookie is unavailable or rejected, surface the failure rather than silently switching data sources.
- Yahoo is allowed for U.S. stock options data and U.S. financial-statement collection. Local U.S. financial-statement requests must use the configured Yahoo proxy; production may access Yahoo finance directly through the unified HTTP client and cache. Do not use Yahoo for stock K-lines, search, Hong Kong financial statements, or other market data.
