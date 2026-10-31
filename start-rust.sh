#!/bin/sh
# Native Rust application. Gracefully replace only this checkout's old server.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# Optional trusted, owner-managed local SDK executable/state configuration.
# Keep machine paths out of committed flow definitions and preserve explicit env.
ACQUISITION_RUNTIME_ENV="${LOCAL_ACQUISITION_RUNTIME_ENV:-data/local/acquisition-runtime.env}"
if [ -f "$ACQUISITION_RUNTIME_ENV" ]; then . "$ACQUISITION_RUNTIME_ENV"; fi
export LLM_RUNTIME=local
unset PRODUCTION_REPORT_SYNC_URL REPORT_SYNC_TOKEN
export PORT="${PORT:-8000}"
export KNOWLEDGE_CONTENT_LOCAL_PORT="${KNOWLEDGE_CONTENT_LOCAL_PORT:-${LOCAL_CONTENT_PORT:-8788}}"
# Only server startup replaces listeners; offline/maintenance CLI leaves them alone.
if [ "$#" -eq 0 ]; then node scripts/prepare-local-ports.mjs; fi
CONTENT_HOST=${HOST:-127.0.0.1}
case "$CONTENT_HOST" in *:*) CONTENT_HOST="[$CONTENT_HOST]" ;; esac
export KNOWLEDGE_CONTENT_PUBLIC_BASE_URL="${KNOWLEDGE_CONTENT_PUBLIC_BASE_URL:-http://${CONTENT_HOST}:${KNOWLEDGE_CONTENT_LOCAL_PORT}}"
# Preserve the existing local content cache when present, without imposing a
# machine-specific path on a fresh checkout.
if [ -z "${KNOWLEDGE_CONTENT_LOCAL_DIR:-}" ] && [ -d /Users/terry/git/data/stock-info/knowledge/content-cache ]; then
  export KNOWLEDGE_CONTENT_LOCAL_DIR=/Users/terry/git/data/stock-info/knowledge/content-cache
fi
export KNOWLEDGE_REPORT_CONVERTER_URL="${KNOWLEDGE_REPORT_CONVERTER_URL:-${KNOWLEDGE_CONTENT_PUBLIC_BASE_URL%/}/__convert-report}"
export KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY="${KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY:-2}"
export KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY="${KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY:-2}"
export KNOWLEDGE_REPORT_CONVERTER_HOSTS="${KNOWLEDGE_REPORT_CONVERTER_HOSTS:-pdf.dfcfw.com,static.cninfo.com.cn,www1.hkexnews.hk}"
export HTTP_PROXY_URL="${HTTP_PROXY_URL:-http://127.0.0.1:7890}"
export HTTP_PROXY_RELAY_URL="${HTTP_PROXY_RELAY_URL:-${HTTP_PROXY_URL%/}/fetch}"
export HTTP_PROXY_DOMAINS="${HTTP_PROXY_DOMAINS:-yahoo.com}"
export HTTP_DOMAIN_CONCURRENCY="${HTTP_DOMAIN_CONCURRENCY:-5}"
export HTTP_REQUEST_TIMEOUT_MS="${HTTP_REQUEST_TIMEOUT_MS:-10000}"
export TASKD_BASE_URL="${TASKD_BASE_URL:-https://task.m2ai.cc}"
export TASKD_NAMESPACE="${TASKD_NAMESPACE:-stock-info}"
export LLM_DAILY_LIMIT="${LLM_DAILY_LIMIT:-1000000}"
export XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS="${XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS:-10800}"
export XUEQIU_COOKIE_REFRESH_RETRY_SECONDS="${XUEQIU_COOKIE_REFRESH_RETRY_SECONDS:-300}"
case "${1:-}" in --help|-h) ;; *)
  npm run build:prompts
  if [ "$#" -eq 0 ] || [ "${1:-}" = "--review-featured-report" ]; then npm run build:web; fi
  ;;
esac
cargo build --locked --manifest-path backend/Cargo.toml
# Node is build tooling only: Cargo metadata locates external target directories.
# Exec the native binary directly so no Cargo process or build lock remains.
TARGET_DIR=$(cargo metadata --locked --no-deps --format-version 1 --manifest-path backend/Cargo.toml | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).target_directory))')
exec "$TARGET_DIR/debug/stock-info-local" "$@"
