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

echo "Type checking..."
npm run typecheck

echo "Building frontend..."
npm run build

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

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "Applying remote D1 migrations for ${DATABASE_NAME}..."
  CI=1 npx wrangler d1 migrations apply "$DATABASE_NAME" --remote
else
  echo "Skipping remote D1 migrations."
fi

echo "Deploying Worker ${WORKER_NAME}..."
npx wrangler deploy --name "$WORKER_NAME"

echo "Recent deployments:"
npx wrangler deployments list --name "$WORKER_NAME"

echo "Verifying https://${PRODUCTION_DOMAIN}/api/health ..."
HEALTH_RESPONSE=$(curl -fsS --max-time 20 "https://${PRODUCTION_DOMAIN}/api/health")
echo "$HEALTH_RESPONSE"

echo "Cloudflare deploy finished."
echo "Production URL: https://${PRODUCTION_DOMAIN}"
echo "Rollback: ./rollback-cloudflare.sh"
