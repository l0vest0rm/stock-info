#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
PORT="${PORT:-8787}"
BASE_URL="http://127.0.0.1:${PORT}"
CONTENT_PORT="${KNOWLEDGE_CONTENT_LOCAL_PORT:-8788}"
CONTENT_BASE_URL="${KNOWLEDGE_CONTENT_PUBLIC_BASE_URL:-http://127.0.0.1:${CONTENT_PORT}}"
CONTENT_DIR="${KNOWLEDGE_CONTENT_LOCAL_DIR:-/Users/terry/git/data/stock-info/knowledge/content-cache}"
LOG_DIR="${PROJECT_ROOT}/data/logs"
LOG_FILE="${LOG_DIR}/stock-info-wrangler.log"
CONTENT_LOG_FILE="${LOG_DIR}/stock-info-knowledge-content.log"

export HTTP_PROXY_URL="${HTTP_PROXY_URL:-http://127.0.0.1:7892}"
export HTTP_PROXY_DOMAINS="yahoo.com"
export HTTP_DOMAIN_CONCURRENCY="3"
export LLM_DAILY_LIMIT="${LLM_DAILY_LIMIT:-1000000}"
export KNOWLEDGE_CONTENT_PUBLIC_BASE_URL="$CONTENT_BASE_URL"
export KNOWLEDGE_CONTENT_LOCAL_DIR="$CONTENT_DIR"

WORKER_VARS=(
  --var "HTTP_PROXY_URL:$HTTP_PROXY_URL"
  --var "HTTP_PROXY_DOMAINS:$HTTP_PROXY_DOMAINS"
  --var "HTTP_DOMAIN_CONCURRENCY:$HTTP_DOMAIN_CONCURRENCY"
  --var "LLM_DAILY_LIMIT:$LLM_DAILY_LIMIT"
  --var "KNOWLEDGE_CONTENT_PUBLIC_BASE_URL:$KNOWLEDGE_CONTENT_PUBLIC_BASE_URL"
)

for key in OPENAI_API_KEY OPENAI_BASE_URL VOLC_ARK_API_KEY VOLC_ARK_BASE_URL LLM_API_KEY LLM_BASE_URL; do
  value="${(P)key-}"
  if [[ -n "$value" ]]; then
    WORKER_VARS+=(--var "${key}:$value")
  fi
done

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

EXISTING_CONTENT_LISTENERS=$(lsof -tiTCP:"$CONTENT_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$EXISTING_CONTENT_LISTENERS" ]]; then
  echo "Stopping existing content listener(s) on port ${CONTENT_PORT}: ${EXISTING_CONTENT_LISTENERS}"
  echo "$EXISTING_CONTENT_LISTENERS" | xargs kill
  sleep 1
fi

echo "Building frontend..."
npm run build

echo "Checking backend and frontend types..."
npm run typecheck

echo "Applying local D1 migrations..."
npm run db:migrate:local

echo "Materializing local knowledge content files..."
node scripts/materialize-local-knowledge-content.mjs --content-dir "$CONTENT_DIR"

echo "Starting local knowledge content server on ${CONTENT_BASE_URL} ..."
: >"$CONTENT_LOG_FILE"
node scripts/local-knowledge-content-server.mjs \
  --host 127.0.0.1 \
  --port "$CONTENT_PORT" \
  --dir "$CONTENT_DIR" \
  >"$CONTENT_LOG_FILE" 2>&1 &
CONTENT_PID=$!

CONTENT_ATTEMPTS=0
until curl -fsS "${CONTENT_BASE_URL}/__health" >/dev/null 2>&1; do
  CONTENT_ATTEMPTS=$((CONTENT_ATTEMPTS + 1))
  if ! kill -0 "$CONTENT_PID" >/dev/null 2>&1; then
    echo "Local knowledge content server exited before becoming healthy."
    echo "Check log: $CONTENT_LOG_FILE"
    wait "$CONTENT_PID" || true
    exit 1
  fi
  if [[ "$CONTENT_ATTEMPTS" -ge 30 ]]; then
    echo "Timed out waiting for ${CONTENT_BASE_URL}/__health"
    echo "Check log: $CONTENT_LOG_FILE"
    kill "$CONTENT_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 1
done

echo "Starting local Worker on ${BASE_URL} ..."
: >"$LOG_FILE"

npm run dev:worker:bare -- \
  --port "$PORT" \
  --show-interactive-dev-session=false \
  "${WORKER_VARS[@]}" \
  >"$LOG_FILE" 2>&1 &
WORKER_PID=$!

ATTEMPTS=0
until curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if ! kill -0 "$WORKER_PID" >/dev/null 2>&1; then
    echo "Local Worker exited before becoming healthy."
    echo "Check log: $LOG_FILE"
    wait "$WORKER_PID" || true
    exit 1
  fi
  if [[ "$ATTEMPTS" -ge 60 ]]; then
    echo "Timed out waiting for ${BASE_URL}/api/health"
    echo "Check log: $LOG_FILE"
    kill "$WORKER_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 1
done

echo "Local site is ready."
echo "URL: ${BASE_URL}"
echo "Health: ${BASE_URL}/api/health"
echo "Log: ${LOG_FILE}"
echo "Knowledge content URL: ${CONTENT_BASE_URL}"
echo "Knowledge content log: ${CONTENT_LOG_FILE}"
echo "HTTP proxy URL: ${HTTP_PROXY_URL}"
echo "HTTP proxy domains: ${HTTP_PROXY_DOMAINS}"
echo "HTTP domain concurrency: ${HTTP_DOMAIN_CONCURRENCY}"
echo "LLM daily limit: ${LLM_DAILY_LIMIT}"
echo "Knowledge content PID: ${CONTENT_PID}"
echo "Worker PID: ${WORKER_PID}"
