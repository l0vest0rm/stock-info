# Stock Info Instructions

## Runtime Model

- Treat this repo as a Cloudflare Worker project in production and a local Wrangler simulation in development.
- Local development should default to `./start-local.sh`.
- The default local URL is `http://127.0.0.1:8787`.
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

## Change Boundaries

- Keep Cloudflare-specific configuration, bindings, migrations, and deploy logic explicit.
- Do not add local-only shortcuts that obscure the Worker/D1 production contract.
