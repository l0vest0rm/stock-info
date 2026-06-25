#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
PORT="${PORT:-8787}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_DIR="${PROJECT_ROOT}/data/logs"
LOG_FILE="${LOG_DIR}/stock-info-wrangler.log"
FETCH_PROXY_LOG_FILE="${LOG_DIR}/stock-info-local-fetch-proxy.log"

# Local-only fetch proxy settings. Cloudflare deploy does not use these.
export LOCAL_FETCH_PROXY_PORT="8791"
export LOCAL_FETCH_PROXY_URL="http://127.0.0.1:${LOCAL_FETCH_PROXY_PORT}"
export HTTP_PROXY_ENABLED="1"
export HTTP_PROXY_URL="$LOCAL_FETCH_PROXY_URL"
export HTTP_PROXY_DOMAINS="yahoo.com"
export HTTP_DOMAIN_CONCURRENCY="3"
export PROXY_ENABLED="1"
export PROXY_URL="PROXY 127.0.0.1:7892"
export PROXY_DOMAINS="yahoo.com"

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

EXISTING_FETCH_PROXY=$(lsof -tiTCP:"$LOCAL_FETCH_PROXY_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$EXISTING_FETCH_PROXY" ]]; then
  echo "Stopping existing local fetch proxy listener(s) on port ${LOCAL_FETCH_PROXY_PORT}: ${EXISTING_FETCH_PROXY}"
  echo "$EXISTING_FETCH_PROXY" | xargs kill
  sleep 1
fi

echo "Building frontend..."
npm run build

echo "Checking backend and frontend types..."
npm run typecheck

echo "Applying local D1 migrations..."
npm run db:migrate:local

echo "Starting local fetch proxy on ${LOCAL_FETCH_PROXY_URL} ..."
: >"$FETCH_PROXY_LOG_FILE"
nohup node scripts/local-fetch-proxy.mjs >"$FETCH_PROXY_LOG_FILE" 2>&1 &
FETCH_PROXY_PID=$!

ATTEMPTS=0
until curl -fsS "${LOCAL_FETCH_PROXY_URL}/health" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ "$ATTEMPTS" -ge 20 ]]; then
    echo "Timed out waiting for ${LOCAL_FETCH_PROXY_URL}/health"
    echo "Check log: $FETCH_PROXY_LOG_FILE"
    kill "$FETCH_PROXY_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "Starting local Worker on ${BASE_URL} ..."
: >"$LOG_FILE"

WORKER_CMD="cd \"$PROJECT_ROOT\" && npm run dev:worker -- --port \"$PORT\" --show-interactive-dev-session=false --var \"LOCAL_FETCH_PROXY_URL:$LOCAL_FETCH_PROXY_URL\" --var \"HTTP_PROXY_ENABLED:$HTTP_PROXY_ENABLED\" --var \"HTTP_PROXY_URL:$HTTP_PROXY_URL\" --var \"HTTP_PROXY_DOMAINS:$HTTP_PROXY_DOMAINS\" --var \"HTTP_DOMAIN_CONCURRENCY:$HTTP_DOMAIN_CONCURRENCY\" 2>&1 | tee \"$LOG_FILE\""
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
echo "Local fetch proxy: ${LOCAL_FETCH_PROXY_URL}"
echo "HTTP proxy enabled: ${HTTP_PROXY_ENABLED}"
echo "HTTP proxy URL: ${HTTP_PROXY_URL}"
echo "HTTP proxy domains: ${HTTP_PROXY_DOMAINS}"
echo "HTTP domain concurrency: ${HTTP_DOMAIN_CONCURRENCY}"
echo "Proxy enabled: ${PROXY_ENABLED}"
echo "Proxy URL: ${PROXY_URL}"
echo "Proxy domains: ${PROXY_DOMAINS}"
echo "Local fetch proxy log: ${FETCH_PROXY_LOG_FILE}"
echo "Worker terminal: opened in macOS Terminal"
