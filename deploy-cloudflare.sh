#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
WORKER_NAME="${CF_WORKER_NAME:-stock-info}"
DATABASE_NAME="${CF_D1_DATABASE:-stock_info}"
PRODUCTION_DOMAIN="${CF_PRODUCTION_DOMAIN:-tinfo.cc}"
DRY_RUN_ONLY=0
SKIP_MIGRATE=0
CREATE_MISSING_R2=0
SKIP_PREFLIGHT=0

usage() {
  cat <<'EOF'
Usage: ./deploy-cloudflare.sh [--dry-run-only] [--skip-migrate] [--create-missing-r2] [--skip-preflight]

Environment:
  CLOUDFLARE_API_TOKEN   Required. API token used by Wrangler.
  CF_WORKER_NAME         Optional. Defaults to stock-info.
  CF_D1_DATABASE         Optional. Defaults to stock_info.
  CF_PRODUCTION_DOMAIN   Optional. Defaults to tinfo.cc.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run-only)
      DRY_RUN_ONLY=1
      ;;
    --skip-migrate)
      SKIP_MIGRATE=1
      ;;
    --create-missing-r2)
      CREATE_MISSING_R2=1
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

cd "$PROJECT_ROOT"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CURRENT_COMMIT=$(git rev-parse --short HEAD)
  echo "Deploying commit: ${CURRENT_COMMIT}"
fi

echo "Checking release inputs, runtime boundaries and types..."
npm run typecheck
npm run check:no-new-tables
npm run check:wrangler-local
npm run check:inline-prompts
npm run check:runtime-boundaries
npm run check:release-inputs

echo "Building production frontend..."
npm run build:web:production

echo "Packaging Worker with dry-run..."
npx wrangler deploy --name "$WORKER_NAME" --dry-run

if [[ "$DRY_RUN_ONLY" -eq 1 ]]; then
  echo "Dry run only; skipping remote migration and live deploy."
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required for live deploy." >&2
  exit 1
fi

echo "Validating local Xueqiu credential before changing the Worker..."
node scripts/refresh-xueqiu-cookie.mjs --validate-local-credential-store

echo "Syncing account email Worker secrets..."
CF_WORKER_NAME="$WORKER_NAME" node scripts/sync-mail-secrets.mjs

if [[ "$SKIP_PREFLIGHT" -eq 0 ]]; then
  echo "Running Cloudflare release preflight..."
  ./scripts/preflight-cloudflare-release.sh
else
  echo "Skipping Cloudflare release preflight."
fi

R2_BUCKETS_TEXT=$(node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.cwd(), "wrangler.jsonc");
const text = fs.readFileSync(file, "utf8");
const parsed = Function(`"use strict"; return (${text});`)();
const buckets = Array.isArray(parsed.r2_buckets)
  ? parsed.r2_buckets
      .map((entry) => String(entry?.bucket_name || "").trim())
      .filter(Boolean)
  : [];
process.stdout.write(buckets.join("\n"));
EOF
)

if [[ -n "$R2_BUCKETS_TEXT" ]]; then
  echo "Checking configured R2 buckets..."
  while IFS= read -r bucket; do
    [[ -n "$bucket" ]] || continue
    if npx wrangler r2 bucket info "$bucket" --json >/dev/null 2>&1; then
      echo "R2 bucket ok: ${bucket}"
      continue
    fi
    if [[ "$CREATE_MISSING_R2" -eq 1 ]]; then
      echo "Creating missing R2 bucket: ${bucket}"
      npx wrangler r2 bucket create "$bucket"
    else
      echo "Configured R2 bucket is missing: ${bucket}" >&2
      echo "Create it first or rerun with --create-missing-r2." >&2
      exit 1
    fi
  done <<EOF
$R2_BUCKETS_TEXT
EOF
else
  echo "No R2 buckets configured in wrangler.jsonc."
fi

# Public PDF/JSON readers fetch the knowledge bucket directly, including Range.
echo "Applying public knowledge content CORS policy..."
npx wrangler r2 bucket cors set "${KNOWLEDGE_CONTENT_BUCKET:-stock-info-knowledge-content}" --file config/knowledge/knowledge-content-cors.json --force

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "Applying remote D1 migrations for ${DATABASE_NAME}..."
  node scripts/apply-remote-migrations.mjs "$DATABASE_NAME"
else
  echo "Skipping remote D1 migrations."
fi

RELEASE_VERSION="${CURRENT_COMMIT:-source}-$(date -u +%Y%m%dT%H%M%SZ)"
echo "Deploying Worker ${WORKER_NAME} (${RELEASE_VERSION})..."
npx wrangler deploy --name "$WORKER_NAME" --var "APP_VERSION:${RELEASE_VERSION}"

echo "Validating and uploading Xueqiu Worker secret..."
# The first deploy removes any legacy versioned Cookie variable. Cloudflare
# cannot replace that binding with a same-named secret in a single `secret put`.
CF_WORKER_NAME="$WORKER_NAME" npm run sync:xueqiu-secret

echo "Recent deployments:"
npx wrangler deployments list --name "$WORKER_NAME"

echo "Verifying deployed version and production D1 health..."
PRODUCTION_BASE_URL="https://${PRODUCTION_DOMAIN}" EXPECTED_APP_VERSION="$RELEASE_VERSION" node --input-type=module <<'EOF'
const url = new URL('/api/health', process.env.PRODUCTION_BASE_URL);
const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`Production health HTTP ${response.status}`);
const body = await response.json();
if (body.code !== 200 || body.data?.d1 !== true) throw new Error('Production D1 health failed');
if (body.data.version !== process.env.EXPECTED_APP_VERSION) {
  throw new Error(`Unexpected deployed version: ${body.data.version}`);
}
console.log(`Production health passed: ${body.data.version}`);
EOF

echo "Verifying production Xueqiu K-line API..."
PRODUCTION_BASE_URL="https://${PRODUCTION_DOMAIN}" node --input-type=module <<'EOF'
const url = new URL('/api/kline', process.env.PRODUCTION_BASE_URL);
url.searchParams.set('code', '002463.SZ');
url.searchParams.set('period', 'day');
url.searchParams.set('fq', 'qfq');
url.searchParams.set('format', 'structured');
// A future upper bound prevents a fresh R2 snapshot from hiding a rejected
// Worker secret; Xueqiu still returns the historical bars before that date.
url.searchParams.set('to', new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
const body = await response.json();
if (!response.ok || body?.code !== 200 || !Array.isArray(body.data) || body.data.length === 0) {
  throw new Error(`Production Xueqiu K-line failed: HTTP ${response.status}, ${body?.msg ?? 'invalid response'}`);
}
console.log(`Production Xueqiu K-line passed: ${body.data.length} rows`);
EOF

echo "Cloudflare deploy finished."
echo "Production URL: https://${PRODUCTION_DOMAIN}"
echo "Rollback: ./rollback-cloudflare.sh"
