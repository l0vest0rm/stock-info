#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DATABASE_NAME="${CF_D1_DATABASE:-stock_info}"
WORKER_NAME="${CF_WORKER_NAME:-stock-info}"
RUN_CLEANUP_DRY_RUN=1
RUN_OBSERVABILITY=1
STRICT_OBSERVABILITY=0

usage() {
  cat <<'EOF'
Usage: ./scripts/preflight-cloudflare-release.sh [--skip-cleanup-dry-run] [--skip-observability] [--strict-observability]

Checks:
  - Cloudflare token validity plus required zone/Worker/D1/R2 access
  - configured R2 buckets exist
  - knowledge content cleanup dry-run
  - Cloudflare observability snapshot

Environment:
  CLOUDFLARE_API_TOKEN   Required
  CF_D1_DATABASE         Optional. Defaults to stock_info
  CF_WORKER_NAME         Optional. Defaults to stock-info

Observability envs when enabled:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ZONE_ID
  CLOUDFLARE_D1_DATABASE_ID
  CLOUDFLARE_WORKER_SCRIPT_NAME
  KNOWLEDGE_CONTENT_BUCKET
  KNOWLEDGE_CONTENT_HOSTNAME

Cleanup dry-run envs when enabled:
  CLOUDFLARE_R2_ENDPOINT
  CLOUDFLARE_R2_ACCESS_KEY_ID
  CLOUDFLARE_R2_SECRET_ACCESS_KEY
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-cleanup-dry-run)
      RUN_CLEANUP_DRY_RUN=0
      ;;
    --skip-observability)
      RUN_OBSERVABILITY=0
      ;;
    --strict-observability)
      STRICT_OBSERVABILITY=1
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

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required." >&2
  exit 1
fi

echo "Checking Cloudflare deploy token..."
npm run check:cloudflare:token -- --require-d1 --require-r2 --require-worker

echo "Checking configured R2 buckets..."
R2_BUCKETS_TEXT=$(node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.cwd(), "wrangler.jsonc");
const text = fs.readFileSync(file, "utf8");
const parsed = Function(`"use strict"; return (${text});`)();
const buckets = Array.isArray(parsed.r2_buckets)
  ? parsed.r2_buckets.map((entry) => String(entry?.bucket_name || "").trim()).filter(Boolean)
  : [];
process.stdout.write(buckets.join("\n"));
EOF
)

while IFS= read -r bucket; do
  [[ -n "$bucket" ]] || continue
  npx wrangler r2 bucket info "$bucket" --json >/dev/null
  echo "R2 bucket ok: ${bucket}"
done <<EOF
$R2_BUCKETS_TEXT
EOF

if [[ "$RUN_CLEANUP_DRY_RUN" -eq 1 ]]; then
  if [[ -n "${CLOUDFLARE_R2_ENDPOINT:-}" && -n "${CLOUDFLARE_R2_ACCESS_KEY_ID:-}" && -n "${CLOUDFLARE_R2_SECRET_ACCESS_KEY:-}" ]]; then
    echo "Running knowledge content cleanup dry-run..."
    node scripts/cleanup-knowledge-content.mjs --remote --dry-run --database "$DATABASE_NAME"
  else
    echo "Skipping cleanup dry-run: missing R2 S3 credentials."
  fi
fi

if [[ "$RUN_OBSERVABILITY" -eq 1 ]]; then
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_D1_DATABASE_ID:-}" ]]; then
    echo "Capturing Cloudflare observability snapshot..."
    CLOUDFLARE_WORKER_SCRIPT_NAME="${CLOUDFLARE_WORKER_SCRIPT_NAME:-$WORKER_NAME}" \
      node scripts/report-cloudflare-observability.mjs --database-name "$DATABASE_NAME"
  elif [[ "$STRICT_OBSERVABILITY" -eq 1 ]]; then
    echo "Missing observability envs: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_D1_DATABASE_ID are required." >&2
    exit 1
  else
    echo "Skipping observability snapshot: missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_D1_DATABASE_ID."
  fi
fi

echo "Cloudflare release preflight finished."
