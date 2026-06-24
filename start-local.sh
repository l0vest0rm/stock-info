#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
PORT="${PORT:-8787}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_DIR="${PROJECT_ROOT}/data/logs"
LOG_FILE="${LOG_DIR}/stock-info-wrangler.log"

mkdir -p "$LOG_DIR"

cd "$PROJECT_ROOT"

EXISTING_WRANGLER_PIDS=$(pgrep -f "node .*wrangler dev --local --port ${PORT}" || true)
if [[ -n "$EXISTING_WRANGLER_PIDS" ]]; then
  echo "Stopping existing wrangler process(es): ${EXISTING_WRANGLER_PIDS}"
  echo "$EXISTING_WRANGLER_PIDS" | xargs kill || true
  sleep 1
fi

EXISTING_LISTENERS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$EXISTING_LISTENERS" ]]; then
  echo "Stopping existing listener(s) on port ${PORT}: ${EXISTING_LISTENERS}"
  echo "$EXISTING_LISTENERS" | xargs kill
  sleep 1
fi

echo "Building frontend..."
npm run build

echo "Checking backend and frontend types..."
npm run typecheck

echo "Applying local D1 migrations..."
npm run db:migrate:local

echo "Starting local Worker on ${BASE_URL} ..."
: >"$LOG_FILE"

WORKER_CMD="cd \"$PROJECT_ROOT\" && npm run dev:worker -- --port \"$PORT\" --show-interactive-dev-session=false 2>&1 | tee \"$LOG_FILE\""
osascript <<EOF >/dev/null
tell application "Terminal"
  activate
  do script "$(printf '%s' "$WORKER_CMD" | sed 's/\\/\\\\/g; s/"/\\"/g')"
end tell
EOF

ATTEMPTS=0
until curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ "$ATTEMPTS" -ge 60 ]]; then
    echo "Timed out waiting for ${BASE_URL}/api/health"
    echo "Check log: $LOG_FILE"
    exit 1
  fi
  sleep 1
done

echo "Local site is ready."
echo "URL: ${BASE_URL}"
echo "Health: ${BASE_URL}/api/health"
echo "Log: ${LOG_FILE}"
echo "Worker terminal: opened in macOS Terminal"
