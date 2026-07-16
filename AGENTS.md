# Stock Info Instructions

## Runtime Model

- Treat this repo as a Cloudflare Worker project in production and a local Wrangler simulation in development.
- Local development should default to `./start-local.sh`.
- The default local URL is `http://127.0.0.1:8000`.
- Production deployment and verification must be treated separately from local `wrangler dev --local`.

## Local Workflow

- Use `./start-local.sh` for the standard local loop because it already builds `web/dist`, typechecks, applies local D1 migrations, starts Wrangler, and waits for `/api/health`.
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

- K-line data must use Eastmoney only. Do not add Tencent, Yahoo, or other K-line fallbacks for A-shares, Hong Kong stocks, U.S. stocks, funds, or indices.
- Yahoo is allowed only for U.S. stock options data. Do not reuse Yahoo endpoints, symbols, proxy configuration, or adapters for K-line, finance, search, or other market data.
- When Eastmoney K-line requests fail, fix the Eastmoney request, cache, retry, connection, or runtime path. Surface the failure rather than silently switching data sources.
