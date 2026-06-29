#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
WORKER_NAME="${CF_WORKER_NAME:-stock-info}"
PRODUCTION_DOMAIN="${CF_PRODUCTION_DOMAIN:-tinfo.cc}"
VERSION_ID=""
MESSAGE="${ROLLBACK_MESSAGE:-Rollback from local script}"

usage() {
  cat <<'EOF'
Usage: ./rollback-cloudflare.sh [version-id] [--message "reason"]

Environment:
  CLOUDFLARE_API_TOKEN   Required. API token used by Wrangler.
  CF_WORKER_NAME         Optional. Defaults to stock-info.
  CF_PRODUCTION_DOMAIN   Optional. Defaults to tinfo.cc.
  ROLLBACK_MESSAGE       Optional default rollback message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --message)
      shift
      if [[ $# -eq 0 ]]; then
        echo "--message requires a value" >&2
        exit 1
      fi
      MESSAGE="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$VERSION_ID" ]]; then
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      VERSION_ID="$1"
      ;;
  esac
  shift
done

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

echo "Current deployments:"
npx wrangler deployments list --name "$WORKER_NAME"

echo "Rolling back Worker ${WORKER_NAME}..."
if [[ -n "$VERSION_ID" ]]; then
  npx wrangler rollback "$VERSION_ID" --name "$WORKER_NAME" --message "$MESSAGE" --yes
else
  npx wrangler rollback --name "$WORKER_NAME" --message "$MESSAGE" --yes
fi

echo "Deployments after rollback:"
npx wrangler deployments list --name "$WORKER_NAME"

echo "Verifying https://${PRODUCTION_DOMAIN}/api/health ..."
HEALTH_RESPONSE=$(curl -fsS --max-time 20 "https://${PRODUCTION_DOMAIN}/api/health")
echo "$HEALTH_RESPONSE"

echo "Rollback finished."
