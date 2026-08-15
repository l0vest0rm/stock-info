#!/bin/zsh

# Build and prepare the local Node data plane once, then hand every resident
# role to the foreground supervisor. Startup replaces only a previous
# supervisor owned by this repository; an unrelated occupied port remains a
# visible startup failure.
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")" && pwd)
LOCAL_START_LOG_FILE="${LOCAL_START_LOG_FILE:-$PROJECT_ROOT/data/logs/stock-info-local-start.log}"
PORT="${PORT:-8000}"
CONTENT_PORT="${KNOWLEDGE_CONTENT_LOCAL_PORT:-8788}"
CONTENT_DIR="${KNOWLEDGE_CONTENT_LOCAL_DIR:-/Users/terry/git/data/stock-info/knowledge/content-cache}"
HTTP_PROXY_URL="${HTTP_PROXY_URL:-http://127.0.0.1:7890}"

export PORT
export KNOWLEDGE_CONTENT_LOCAL_PORT="$CONTENT_PORT"
export KNOWLEDGE_CONTENT_PUBLIC_BASE_URL="${KNOWLEDGE_CONTENT_PUBLIC_BASE_URL:-http://127.0.0.1:${CONTENT_PORT}}"
export KNOWLEDGE_CONTENT_LOCAL_DIR="$CONTENT_DIR"
export KNOWLEDGE_REPORT_CONVERTER_URL="${KNOWLEDGE_REPORT_CONVERTER_URL:-${KNOWLEDGE_CONTENT_PUBLIC_BASE_URL%/}/__convert-report}"
export KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY="${KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY:-2}"
export KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY="${KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY:-2}"
export KNOWLEDGE_REPORT_CONVERTER_HOSTS="${KNOWLEDGE_REPORT_CONVERTER_HOSTS:-pdf.dfcfw.com,static.cninfo.com.cn,www1.hkexnews.hk}"
export HTTP_PROXY_URL
export HTTP_PROXY_RELAY_URL="${HTTP_PROXY_RELAY_URL:-${HTTP_PROXY_URL%/}/fetch}"
export HTTP_PROXY_DOMAINS="${HTTP_PROXY_DOMAINS:-yahoo.com}"
export HTTP_DOMAIN_CONCURRENCY="${HTTP_DOMAIN_CONCURRENCY:-5}"
export HTTP_REQUEST_TIMEOUT_MS="${HTTP_REQUEST_TIMEOUT_MS:-10000}"
export LLM_RUNTIME="local"
# taskd is the local-development execution service for the explicit ChatGPT
# research flows.  The Node binding loader reads STOCK_INFO_TASKD_CALLER_TOKEN
# from this repository's ignored .dev.vars before starting the HTTP server;
# callers therefore run this script directly without exporting a token.
export TASKD_BASE_URL="${TASKD_BASE_URL:-https://task.m2ai.cc}"
export TASKD_NAMESPACE="${TASKD_NAMESPACE:-stock-info}"
export LLM_DAILY_LIMIT="${LLM_DAILY_LIMIT:-1000000}"
export XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS="${XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS:-21600}"
export XUEQIU_COOKIE_REFRESH_RETRY_SECONDS="${XUEQIU_COOKIE_REFRESH_RETRY_SECONDS:-300}"

if [[ "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS" != <-> || "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS" -lt 300 ]]; then
  print -u2 "XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS must be an integer of at least 300 seconds."
  exit 1
fi
if [[ "$XUEQIU_COOKIE_REFRESH_RETRY_SECONDS" != <-> || "$XUEQIU_COOKIE_REFRESH_RETRY_SECONDS" -lt 60 || "$XUEQIU_COOKIE_REFRESH_RETRY_SECONDS" -gt "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS" ]]; then
  print -u2 "XUEQIU_COOKIE_REFRESH_RETRY_SECONDS must be an integer from 60 seconds to XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS."
  exit 1
fi

cd "$PROJECT_ROOT"

print "Stopping any previous local supervisor owned by this repository..."
node scripts/local-supervisor.mjs --stop-previous

print "Building prompts, web assets, and Node runtime once..."
npm run build:local

print "Applying migrations to the explicit local Node SQLite database..."
npm run db:migrate:local

print "Materializing local knowledge content files..."
node scripts/materialize-local-knowledge-content.mjs --content-dir "$CONTENT_DIR"

proxy_health_url="${HTTP_PROXY_RELAY_URL%/}/__health"
if ! curl -fsS "$proxy_health_url" >/dev/null; then
  print -u2 "External proxy client fetch relay is unavailable: ${proxy_health_url}"
  print -u2 "Start /Users/terry/git/proxy/scripts/start-local-client.sh first."
  exit 1
fi

print "Starting local supervisor; runtime output will be written to ${LOCAL_START_LOG_FILE}..."
mkdir -p "${LOCAL_START_LOG_FILE:h}"
exec node scripts/local-supervisor.mjs >>"$LOCAL_START_LOG_FILE" 2>&1
