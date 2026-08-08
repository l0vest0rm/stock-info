#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
PORT="${PORT:-8000}"
BASE_URL="http://127.0.0.1:${PORT}"
CONTENT_PORT="${KNOWLEDGE_CONTENT_LOCAL_PORT:-8788}"
MACRO_FETCH_RELAY_PORT="${MACRO_FETCH_RELAY_PORT:-8791}"
MACRO_FETCH_RELAY_URL="${MACRO_FETCH_RELAY_URL:-http://127.0.0.1:${MACRO_FETCH_RELAY_PORT}/fetch}"
CONTENT_BASE_URL="${KNOWLEDGE_CONTENT_PUBLIC_BASE_URL:-http://127.0.0.1:${CONTENT_PORT}}"
CONTENT_DIR="${KNOWLEDGE_CONTENT_LOCAL_DIR:-/Users/terry/git/data/stock-info/knowledge/content-cache}"
LOG_DIR="${PROJECT_ROOT}/data/logs"
LOG_FILE="${LOG_DIR}/stock-info-wrangler.log"
CONTENT_LOG_FILE="${LOG_DIR}/stock-info-knowledge-content.log"
CRON_LOG_FILE="${LOG_DIR}/stock-info-local-cron.log"
CRON_PID_FILE="${LOG_DIR}/stock-info-local-cron.pid"
KNOWLEDGE_INGEST_LOG_FILE="${LOG_DIR}/stock-info-knowledge-ingest.log"
KNOWLEDGE_INGEST_PID_FILE="${LOG_DIR}/stock-info-knowledge-ingest.pid"
WEB_SEARCH_RUNNER_LOG_FILE="${LOG_DIR}/stock-info-web-search-runner.log"
WEB_SEARCH_RUNNER_PID_FILE="${LOG_DIR}/stock-info-web-search-runner.pid"
OPERATING_ANALYSIS_RUNNER_LOG_FILE="${LOG_DIR}/stock-info-operating-analysis-runner.log"
OPERATING_ANALYSIS_RUNNER_PID_FILE="${LOG_DIR}/stock-info-operating-analysis-runner.pid"
OPERATING_ANALYSIS_RUNNER_FINGERPRINT_FILE="${LOG_DIR}/stock-info-operating-analysis-runner.fingerprint"
INFORMATION_PROCESSING_RUNNER_LOG_FILE="${LOG_DIR}/stock-info-information-processing-runner.log"
INFORMATION_PROCESSING_RUNNER_PID_FILE="${LOG_DIR}/stock-info-information-processing-runner.pid"
KNOWLEDGE_INGEST_SCHEDULER="${KNOWLEDGE_INGEST_SCHEDULER:-1}"
INFORMATION_PROCESSING_RUNNER="${INFORMATION_PROCESSING_RUNNER:-0}"
PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS="${PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS:-1}"
MACRO_FETCH_RELAY_LOG_FILE="${LOG_DIR}/stock-info-macro-fetch-relay.log"
COOKIE_REFRESH_LOG_FILE="${LOG_DIR}/stock-info-xueqiu-cookie-refresh.log"
COOKIE_REFRESH_PID_FILE="${LOG_DIR}/stock-info-xueqiu-cookie-refresh.pid"
COOKIE_REFRESH_STATE_FILE="${LOG_DIR}/stock-info-xueqiu-cookie-refresh.last-success"
WORKER_PID_FILE="${LOG_DIR}/stock-info-wrangler.pid"
WORKER_WATCHDOG_LOG_FILE="${LOG_DIR}/stock-info-worker-watchdog.log"
WORKER_WATCHDOG_PID_FILE="${LOG_DIR}/stock-info-worker-watchdog.pid"
WORKER_HEALTH_CHECK_INTERVAL_SECONDS="${WORKER_HEALTH_CHECK_INTERVAL_SECONDS:-5}"
WORKER_RESTART_LOCK_DIR="${LOG_DIR}/stock-info-worker-restart.lock"
XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS="${XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS:-21600}"

export HTTP_PROXY_URL="${HTTP_PROXY_URL:-http://127.0.0.1:7890}"
export HTTP_PROXY_RELAY_URL="${HTTP_PROXY_RELAY_URL:-${HTTP_PROXY_URL%/}/fetch}"
export HTTP_PROXY_DOMAINS="${HTTP_PROXY_DOMAINS:-yahoo.com}"
export HTTP_DOMAIN_CONCURRENCY="${HTTP_DOMAIN_CONCURRENCY:-5}"
export HTTP_REQUEST_TIMEOUT_MS="${HTTP_REQUEST_TIMEOUT_MS:-10000}"
export LLM_DAILY_LIMIT="${LLM_DAILY_LIMIT:-1000000}"
export KNOWLEDGE_CONTENT_PUBLIC_BASE_URL="$CONTENT_BASE_URL"
export KNOWLEDGE_CONTENT_LOCAL_DIR="$CONTENT_DIR"
export KNOWLEDGE_REPORT_CONVERTER_URL="${KNOWLEDGE_REPORT_CONVERTER_URL:-${CONTENT_BASE_URL%/}/__convert-report}"
export KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY="${KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY:-2}"
export KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY="${KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY:-2}"
# The local converter is an explicit, narrow PDF allowlist.  CNINFO/HKEX are
# statutory evidence registries only; this does not add a market-data source
# or a production conversion path.
export KNOWLEDGE_REPORT_CONVERTER_HOSTS="${KNOWLEDGE_REPORT_CONVERTER_HOSTS:-pdf.dfcfw.com,static.cninfo.com.cn,www1.hkexnews.hk}"

# The desktop Codex credential is an existing local development credential.
# Load it only when the caller did not provide an explicit LLM key; never
# persist it to .dev.vars or pass it to production deployment commands.
if [[ -z "${OPENAI_API_KEY:-}" && -z "${LLM_API_KEY:-}" && -f "$HOME/.codex/auth.json" ]]; then
  OPENAI_API_KEY=$(node -e 'const fs=require("fs"); try { const v=JSON.parse(fs.readFileSync(process.env.HOME+"/.codex/auth.json","utf8")).OPENAI_API_KEY; if (typeof v === "string" && v.trim()) process.stdout.write(v.trim()); } catch {}')
  export OPENAI_API_KEY
fi

WORKER_VARS=(
  --var "HTTP_PROXY_URL:$HTTP_PROXY_URL"
  --var "HTTP_PROXY_RELAY_URL:$HTTP_PROXY_RELAY_URL"
  --var "HTTP_PROXY_DOMAINS:$HTTP_PROXY_DOMAINS"
  --var "HTTP_DOMAIN_CONCURRENCY:$HTTP_DOMAIN_CONCURRENCY"
  --var "HTTP_REQUEST_TIMEOUT_MS:$HTTP_REQUEST_TIMEOUT_MS"
  --var "LLM_DAILY_LIMIT:$LLM_DAILY_LIMIT"
  --var "LLM_RUNTIME:local"
  --var "KNOWLEDGE_CONTENT_PUBLIC_BASE_URL:$KNOWLEDGE_CONTENT_PUBLIC_BASE_URL"
  --var "KNOWLEDGE_REPORT_CONVERTER_URL:$KNOWLEDGE_REPORT_CONVERTER_URL"
  --var "KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY:$KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY"
  --var "MACRO_FETCH_RELAY_URL:$MACRO_FETCH_RELAY_URL"
)

for key in OPENAI_BASE_URL LLM_BASE_URL; do
  value="${(P)key-}"
  if [[ -n "$value" ]]; then
    WORKER_VARS+=(--var "${key}:$value")
  fi
done

mkdir -p "$LOG_DIR"

cd "$PROJECT_ROOT"

# The local llm-client runner may survive a Worker restart, but it cannot
# safely survive a prompt/runner/config change: Node has already loaded those
# inputs into memory. Track source inputs (not generated output) so a change
# forces one restart.
OPERATING_ANALYSIS_RUNNER_FINGERPRINT=$(shasum -a 256 \
  "$PROJECT_ROOT/scripts/research-operating-analysis-runner.mjs" \
  "$PROJECT_ROOT/scripts/build-prompts.mjs" \
  "$PROJECT_ROOT/prompts/research/operating-analysis.md" \
  "$PROJECT_ROOT/config/research-operating-analysis.json" \
  | shasum -a 256 | awk '{print $1}')

if [[ "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS" != <-> || "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS" -lt 300 ]]; then
  echo "XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS must be an integer of at least 300 seconds."
  exit 1
fi

if [[ "$WORKER_HEALTH_CHECK_INTERVAL_SECONDS" != <-> || "$WORKER_HEALTH_CHECK_INTERVAL_SECONDS" -lt 2 ]]; then
  echo "WORKER_HEALTH_CHECK_INTERVAL_SECONDS must be an integer of at least 2 seconds."
  exit 1
fi

if [[ "$PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS" != "0" && "$PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS" != "1" ]]; then
  echo "PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS must be 0 or 1."
  exit 1
fi

if [[ "$INFORMATION_PROCESSING_RUNNER" != "0" && "$INFORMATION_PROCESSING_RUNNER" != "1" ]]; then
  echo "INFORMATION_PROCESSING_RUNNER must be 0 or 1."
  exit 1
fi

if [[ -f "$WORKER_WATCHDOG_PID_FILE" ]]; then
  EXISTING_WATCHDOG_PID=$(<"$WORKER_WATCHDOG_PID_FILE")
  EXISTING_WATCHDOG_COMMAND=""
  if [[ "$EXISTING_WATCHDOG_PID" == <-> ]]; then
    EXISTING_WATCHDOG_COMMAND=$(ps -p "$EXISTING_WATCHDOG_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_WATCHDOG_COMMAND" == *"start-local.sh"* ]]; then
    echo "Stopping existing local Worker watchdog: ${EXISTING_WATCHDOG_PID}"
    kill "$EXISTING_WATCHDOG_PID" || true
    sleep 1
  fi
  rm -f "$WORKER_WATCHDOG_PID_FILE"
fi
rmdir "$WORKER_RESTART_LOCK_DIR" 2>/dev/null || true

if [[ -f "$COOKIE_REFRESH_PID_FILE" ]]; then
  EXISTING_COOKIE_REFRESH_PID=$(<"$COOKIE_REFRESH_PID_FILE")
  EXISTING_COOKIE_REFRESH_COMMAND=""
  if [[ "$EXISTING_COOKIE_REFRESH_PID" == <-> ]]; then
    EXISTING_COOKIE_REFRESH_COMMAND=$(ps -p "$EXISTING_COOKIE_REFRESH_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_COOKIE_REFRESH_COMMAND" == *"start-local.sh"* ]]; then
    echo "Stopping existing Xueqiu cookie refresher: ${EXISTING_COOKIE_REFRESH_PID}"
    kill "$EXISTING_COOKIE_REFRESH_PID" || true
    sleep 1
  fi
  rm -f "$COOKIE_REFRESH_PID_FILE"
fi

if [[ -f "$CRON_PID_FILE" ]]; then
  EXISTING_CRON_PID=$(<"$CRON_PID_FILE")
  EXISTING_CRON_COMMAND=""
  if [[ "$EXISTING_CRON_PID" == <-> ]]; then
    EXISTING_CRON_COMMAND=$(ps -p "$EXISTING_CRON_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_CRON_COMMAND" == *"scripts/local-cron-runner.mjs"* ]]; then
    echo "Stopping existing local cron runner: ${EXISTING_CRON_PID}"
    kill "$EXISTING_CRON_PID" || true
    sleep 1
  fi
  rm -f "$CRON_PID_FILE"
fi

if [[ -f "$KNOWLEDGE_INGEST_PID_FILE" ]]; then
  EXISTING_KNOWLEDGE_INGEST_PID=$(<"$KNOWLEDGE_INGEST_PID_FILE")
  EXISTING_KNOWLEDGE_INGEST_COMMAND=""
  if [[ "$EXISTING_KNOWLEDGE_INGEST_PID" == <-> ]]; then
    EXISTING_KNOWLEDGE_INGEST_COMMAND=$(ps -p "$EXISTING_KNOWLEDGE_INGEST_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_KNOWLEDGE_INGEST_COMMAND" == *"knowledge-ingest-scheduler.mjs"* ]]; then
    echo "Stopping existing knowledge ingest scheduler: ${EXISTING_KNOWLEDGE_INGEST_PID}"
    kill "$EXISTING_KNOWLEDGE_INGEST_PID" || true
    sleep 1
  fi
  rm -f "$KNOWLEDGE_INGEST_PID_FILE"
fi

if [[ -f "$WEB_SEARCH_RUNNER_PID_FILE" ]]; then
  EXISTING_WEB_SEARCH_RUNNER_PID=$(<"$WEB_SEARCH_RUNNER_PID_FILE")
  EXISTING_WEB_SEARCH_RUNNER_COMMAND=""
  if [[ "$EXISTING_WEB_SEARCH_RUNNER_PID" == <-> ]]; then
    EXISTING_WEB_SEARCH_RUNNER_COMMAND=$(ps -p "$EXISTING_WEB_SEARCH_RUNNER_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_WEB_SEARCH_RUNNER_COMMAND" == *"research-web-search-package-runner.mjs"* ]]; then
    if [[ "$PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS" == "1" ]]; then
      echo "Keeping active local Web Search package runner: ${EXISTING_WEB_SEARCH_RUNNER_PID}"
      WEB_SEARCH_RUNNER_PID="$EXISTING_WEB_SEARCH_RUNNER_PID"
      WEB_SEARCH_RUNNER_REUSED=1
    else
      echo "Stopping existing local Web Search package runner: ${EXISTING_WEB_SEARCH_RUNNER_PID}"
      kill "$EXISTING_WEB_SEARCH_RUNNER_PID" || true
      sleep 1
    fi
  fi
  [[ "${WEB_SEARCH_RUNNER_REUSED:-0}" == "1" ]] || rm -f "$WEB_SEARCH_RUNNER_PID_FILE"
fi

if [[ -f "$OPERATING_ANALYSIS_RUNNER_PID_FILE" ]]; then
  EXISTING_OPERATING_ANALYSIS_RUNNER_PID=$(<"$OPERATING_ANALYSIS_RUNNER_PID_FILE")
  EXISTING_OPERATING_ANALYSIS_RUNNER_COMMAND=""
  if [[ "$EXISTING_OPERATING_ANALYSIS_RUNNER_PID" == <-> ]]; then
    EXISTING_OPERATING_ANALYSIS_RUNNER_COMMAND=$(ps -p "$EXISTING_OPERATING_ANALYSIS_RUNNER_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_OPERATING_ANALYSIS_RUNNER_COMMAND" == *"research-operating-analysis-runner.mjs"* ]]; then
    EXISTING_OPERATING_ANALYSIS_RUNNER_FINGERPRINT=""
    if [[ -f "$OPERATING_ANALYSIS_RUNNER_FINGERPRINT_FILE" ]]; then
      EXISTING_OPERATING_ANALYSIS_RUNNER_FINGERPRINT=$(<"$OPERATING_ANALYSIS_RUNNER_FINGERPRINT_FILE")
    fi
    if [[ "$PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS" == "1" && -n "$EXISTING_OPERATING_ANALYSIS_RUNNER_FINGERPRINT" && "$EXISTING_OPERATING_ANALYSIS_RUNNER_FINGERPRINT" == "$OPERATING_ANALYSIS_RUNNER_FINGERPRINT" ]]; then
      echo "Keeping active local operating analysis runner: ${EXISTING_OPERATING_ANALYSIS_RUNNER_PID}"
      OPERATING_ANALYSIS_RUNNER_PID="$EXISTING_OPERATING_ANALYSIS_RUNNER_PID"
      OPERATING_ANALYSIS_RUNNER_REUSED=1
    else
      if [[ "$PRESERVE_ACTIVE_LOCAL_RESEARCH_RUNNERS" == "1" ]]; then
        echo "Restarting local operating analysis runner because its prompt or source changed: ${EXISTING_OPERATING_ANALYSIS_RUNNER_PID}"
      else
        echo "Stopping existing local operating analysis runner: ${EXISTING_OPERATING_ANALYSIS_RUNNER_PID}"
      fi
      kill "$EXISTING_OPERATING_ANALYSIS_RUNNER_PID" || true
      sleep 1
    fi
  fi
  if [[ "${OPERATING_ANALYSIS_RUNNER_REUSED:-0}" != "1" ]]; then
    rm -f "$OPERATING_ANALYSIS_RUNNER_PID_FILE"
    rm -f "$OPERATING_ANALYSIS_RUNNER_FINGERPRINT_FILE"
  fi
fi

if [[ -f "$INFORMATION_PROCESSING_RUNNER_PID_FILE" ]]; then
  EXISTING_INFORMATION_PROCESSING_RUNNER_PID=$(<"$INFORMATION_PROCESSING_RUNNER_PID_FILE")
  EXISTING_INFORMATION_PROCESSING_RUNNER_COMMAND=""
  if [[ "$EXISTING_INFORMATION_PROCESSING_RUNNER_PID" == <-> ]]; then
    EXISTING_INFORMATION_PROCESSING_RUNNER_COMMAND=$(ps -p "$EXISTING_INFORMATION_PROCESSING_RUNNER_PID" -o command= 2>/dev/null || true)
  fi
  if [[ "$EXISTING_INFORMATION_PROCESSING_RUNNER_COMMAND" == *"information-processing-runner.mjs"* ]]; then
    echo "Stopping existing local information processing runner: ${EXISTING_INFORMATION_PROCESSING_RUNNER_PID}"
    kill "$EXISTING_INFORMATION_PROCESSING_RUNNER_PID" || true
    sleep 1
  fi
  rm -f "$INFORMATION_PROCESSING_RUNNER_PID_FILE"
fi

refresh_xueqiu_cookie() {
  if npm run refresh:xueqiu-cookie >>"$COOKIE_REFRESH_LOG_FILE" 2>&1; then
    date +%s >"$COOKIE_REFRESH_STATE_FILE"
    echo "Xueqiu cookie refreshed from CDP in .dev.vars and wrangler.jsonc."
    return 0
  fi
  echo "Xueqiu CDP cookie refresh failed; keeping the existing variables. Check ${COOKIE_REFRESH_LOG_FILE}." >&2
  return 1
}

seconds_until_xueqiu_cookie_refresh() {
  local last_success now elapsed
  if [[ ! -f "$COOKIE_REFRESH_STATE_FILE" ]]; then
    echo 0
    return
  fi
  last_success=$(<"$COOKIE_REFRESH_STATE_FILE")
  if [[ "$last_success" != <-> ]]; then
    echo 0
    return
  fi
  now=$(date +%s)
  elapsed=$((now - last_success))
  if [[ "$elapsed" -lt 0 || "$elapsed" -ge "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS" ]]; then
    echo 0
    return
  fi
  echo $((XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS - elapsed))
}

start_worker() {
  # Wrangler only exposes variables declared through its local environment
  # file.  Keep the remote-model credential out of command arguments, logs,
  # .dev.vars and D1; a fresh 0600 file is enough for each Worker startup.
  local llm_env_file=""
  local -a llm_env_args=()
  if [[ -n "${OPENAI_API_KEY:-}" && "${OPENAI_API_KEY}" != *$'\n'* ]]; then
    llm_env_file=$(mktemp "${TMPDIR:-/tmp}/stock-info-llm.XXXXXX")
    chmod 600 "$llm_env_file"
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >"$llm_env_file"
    llm_env_args=(--env-file "$llm_env_file")
  fi
  nohup npm run dev:worker:bare -- \
    --port "$PORT" \
    --show-interactive-dev-session=false \
    "${llm_env_args[@]}" \
    "${WORKER_VARS[@]}" \
    </dev/null >>"$LOG_FILE" 2>&1 &
  WORKER_PID=$!
  echo "$WORKER_PID" >"$WORKER_PID_FILE"
  if [[ -n "$llm_env_file" ]]; then
    ( sleep 5; rm -f "$llm_env_file" ) &
  fi
}

wait_for_worker() {
  ATTEMPTS=0
  until curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if ! kill -0 "$WORKER_PID" >/dev/null 2>&1; then
      echo "Local Worker exited before becoming healthy."
      echo "Check log: $LOG_FILE"
      wait "$WORKER_PID" || true
      return 1
    fi
    if [[ "$ATTEMPTS" -ge 60 ]]; then
      echo "Timed out waiting for ${BASE_URL}/api/health"
      echo "Check log: $LOG_FILE"
      kill "$WORKER_PID" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 1
  done
}

restart_worker_with_refreshed_cookie() {
  # Both the watchdog and cookie refresher can notice an unhealthy Worker.
  # An atomic directory lock ensures only one performs the restart; runners
  # remain separate processes and are intentionally never touched here.
  if ! mkdir "$WORKER_RESTART_LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  local restart_status=0
  if [[ -f "$WORKER_PID_FILE" ]]; then
    ACTIVE_WORKER_PID=$(<"$WORKER_PID_FILE")
    if [[ "$ACTIVE_WORKER_PID" == <-> ]] && kill -0 "$ACTIVE_WORKER_PID" >/dev/null 2>&1; then
      echo "Restarting local Worker to load the refreshed Xueqiu cookie."
      kill "$ACTIVE_WORKER_PID" || true
      sleep 1
    fi
  fi
  EXISTING_LISTENERS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$EXISTING_LISTENERS" ]]; then
    echo "$EXISTING_LISTENERS" | xargs kill
    sleep 1
  fi
  start_worker
  if ! wait_for_worker; then
    restart_status=1
  fi
  rmdir "$WORKER_RESTART_LOCK_DIR" 2>/dev/null || true
  return "$restart_status"
}

: >"$COOKIE_REFRESH_LOG_FILE"
COOKIE_REFRESH_WAIT_SECONDS=$(seconds_until_xueqiu_cookie_refresh)
if [[ "$COOKIE_REFRESH_WAIT_SECONDS" -eq 0 ]]; then
  echo "Refreshing Xueqiu cookie through CDP before starting local services..."
  refresh_xueqiu_cookie || true
else
  echo "Skipping Xueqiu cookie refresh; next refresh is due in ${COOKIE_REFRESH_WAIT_SECONDS}s."
fi

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

EXISTING_MACRO_RELAY_LISTENERS=$(lsof -tiTCP:"$MACRO_FETCH_RELAY_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$EXISTING_MACRO_RELAY_LISTENERS" ]]; then
  echo "Stopping existing macro fetch relay listener(s) on port ${MACRO_FETCH_RELAY_PORT}: ${EXISTING_MACRO_RELAY_LISTENERS}"
  echo "$EXISTING_MACRO_RELAY_LISTENERS" | xargs kill
  sleep 1
fi

echo "Building frontend..."
npm run build

echo "Checking backend and frontend types..."
npm run typecheck

echo "Applying local D1 migrations..."
npm run db:migrate:local

echo "Clearing unfinished local Web Search jobs from the previous Worker..."
node scripts/clear-local-web-search-package-jobs.mjs

echo "Materializing local knowledge content files..."
node scripts/materialize-local-knowledge-content.mjs --content-dir "$CONTENT_DIR"

echo "Starting local knowledge content server on ${CONTENT_BASE_URL} ..."
: >"$CONTENT_LOG_FILE"
nohup node scripts/local-knowledge-content-server.mjs \
  --host 127.0.0.1 \
  --port "$CONTENT_PORT" \
  --dir "$CONTENT_DIR" \
  </dev/null >"$CONTENT_LOG_FILE" 2>&1 &
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

HTTP_PROXY_RELAY_HEALTH_URL="${HTTP_PROXY_RELAY_URL%/}/__health"
if ! curl -fsS "$HTTP_PROXY_RELAY_HEALTH_URL" >/dev/null 2>&1; then
  echo "Local proxy client fetch relay is unavailable: ${HTTP_PROXY_RELAY_HEALTH_URL}"
  echo "Start /Users/terry/git/proxy/scripts/start-local-client.sh first."
  kill "$CONTENT_PID" >/dev/null 2>&1 || true
  exit 1
fi


echo "Starting local macro fetch relay on ${MACRO_FETCH_RELAY_URL} ..."
: >"$MACRO_FETCH_RELAY_LOG_FILE"
MACRO_FETCH_RELAY_PORT="$MACRO_FETCH_RELAY_PORT" nohup node scripts/local-macro-fetch-relay.mjs </dev/null >"$MACRO_FETCH_RELAY_LOG_FILE" 2>&1 &
MACRO_FETCH_RELAY_PID=$!
MACRO_RELAY_ATTEMPTS=0
until curl -fsS "http://127.0.0.1:${MACRO_FETCH_RELAY_PORT}/__health" >/dev/null 2>&1; do
  MACRO_RELAY_ATTEMPTS=$((MACRO_RELAY_ATTEMPTS + 1))
  if ! kill -0 "$MACRO_FETCH_RELAY_PID" >/dev/null 2>&1; then
    echo "Local macro fetch relay exited before becoming healthy."
    echo "Check log: $MACRO_FETCH_RELAY_LOG_FILE"
    wait "$MACRO_FETCH_RELAY_PID" || true
    exit 1
  fi
  if [[ "$MACRO_RELAY_ATTEMPTS" -ge 30 ]]; then
    echo "Timed out waiting for local macro fetch relay"
    kill "$MACRO_FETCH_RELAY_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 1
done

echo "Starting local Worker on ${BASE_URL} ..."
: >"$LOG_FILE"

start_worker
if ! wait_for_worker; then
  exit 1
fi

if [[ "${WEB_SEARCH_RUNNER_REUSED:-0}" != "1" ]]; then
  echo "Starting local Web Search package runner ..."
  : >"$WEB_SEARCH_RUNNER_LOG_FILE"
  nohup node scripts/research-web-search-package-runner.mjs \
    </dev/null >"$WEB_SEARCH_RUNNER_LOG_FILE" 2>&1 &
  WEB_SEARCH_RUNNER_PID=$!
  echo "$WEB_SEARCH_RUNNER_PID" >"$WEB_SEARCH_RUNNER_PID_FILE"
  sleep 1
  if ! kill -0 "$WEB_SEARCH_RUNNER_PID" >/dev/null 2>&1; then
    echo "Local Web Search package runner exited during startup."
    echo "Check log: $WEB_SEARCH_RUNNER_LOG_FILE"
    wait "$WEB_SEARCH_RUNNER_PID" || true
    exit 1
  fi
fi

if [[ "${OPERATING_ANALYSIS_RUNNER_REUSED:-0}" != "1" ]]; then
  echo "Starting local operating analysis runner ..."
  : >"$OPERATING_ANALYSIS_RUNNER_LOG_FILE"
  nohup node scripts/research-operating-analysis-runner.mjs \
    </dev/null >"$OPERATING_ANALYSIS_RUNNER_LOG_FILE" 2>&1 &
  OPERATING_ANALYSIS_RUNNER_PID=$!
  echo "$OPERATING_ANALYSIS_RUNNER_PID" >"$OPERATING_ANALYSIS_RUNNER_PID_FILE"
  print -r -- "$OPERATING_ANALYSIS_RUNNER_FINGERPRINT" >"$OPERATING_ANALYSIS_RUNNER_FINGERPRINT_FILE"
  sleep 1
  if ! kill -0 "$OPERATING_ANALYSIS_RUNNER_PID" >/dev/null 2>&1; then
    echo "Local operating analysis runner exited during startup."
    echo "Check log: $OPERATING_ANALYSIS_RUNNER_LOG_FILE"
    wait "$OPERATING_ANALYSIS_RUNNER_PID" || true
    exit 1
  fi
fi

INFORMATION_PROCESSING_RUNNER_PID=""
if [[ "$INFORMATION_PROCESSING_RUNNER" == "1" ]]; then
  echo "Starting local information processing runner ..."
  : >"$INFORMATION_PROCESSING_RUNNER_LOG_FILE"
  nohup node scripts/information-processing-runner.mjs \
    </dev/null >"$INFORMATION_PROCESSING_RUNNER_LOG_FILE" 2>&1 &
  INFORMATION_PROCESSING_RUNNER_PID=$!
  echo "$INFORMATION_PROCESSING_RUNNER_PID" >"$INFORMATION_PROCESSING_RUNNER_PID_FILE"
  sleep 1
  if ! kill -0 "$INFORMATION_PROCESSING_RUNNER_PID" >/dev/null 2>&1; then
    echo "Local information processing runner exited during startup."
    echo "Check log: $INFORMATION_PROCESSING_RUNNER_LOG_FILE"
    wait "$INFORMATION_PROCESSING_RUNNER_PID" || true
    exit 1
  fi
else
  echo "Local information processing runner is disabled (set INFORMATION_PROCESSING_RUNNER=1 to enable it)."
fi

echo "Starting local cron runner from wrangler.jsonc ..."
: >"$CRON_LOG_FILE"
nohup node scripts/local-cron-runner.mjs \
  --base-url "$BASE_URL" \
  --config "$PROJECT_ROOT/wrangler.jsonc" \
  </dev/null >"$CRON_LOG_FILE" 2>&1 &
CRON_PID=$!
echo "$CRON_PID" >"$CRON_PID_FILE"
sleep 1
if ! kill -0 "$CRON_PID" >/dev/null 2>&1; then
  echo "Local cron runner exited during startup."
  echo "Check log: $CRON_LOG_FILE"
  wait "$CRON_PID" || true
  exit 1
fi

KNOWLEDGE_INGEST_PID=""
if [[ "$KNOWLEDGE_INGEST_SCHEDULER" == "1" ]]; then
  echo "Starting local knowledge ingest scheduler ..."
  : >"$KNOWLEDGE_INGEST_LOG_FILE"
  nohup node scripts/knowledge-ingest-scheduler.mjs "$PROJECT_ROOT/config/knowledge-processing.json" \
    </dev/null >"$KNOWLEDGE_INGEST_LOG_FILE" 2>&1 &
  KNOWLEDGE_INGEST_PID=$!
  echo "$KNOWLEDGE_INGEST_PID" >"$KNOWLEDGE_INGEST_PID_FILE"
  sleep 1
  if ! kill -0 "$KNOWLEDGE_INGEST_PID" >/dev/null 2>&1; then
    echo "Knowledge ingest scheduler exited during startup."
    echo "Check log: $KNOWLEDGE_INGEST_LOG_FILE"
    wait "$KNOWLEDGE_INGEST_PID" || true
    exit 1
  fi
else
  echo "Local knowledge ingest scheduler is disabled (set KNOWLEDGE_INGEST_SCHEDULER=1 to enable it)."
fi

# `wrangler dev --local` has a separate ProxyController/workerd process. It
# can exit after a local runtime disconnect while the independent task runners
# remain healthy. Watch the actual HTTP boundary and restart only that Worker;
# D1 task rows and local research-runner processes are preserved.
echo "Starting local Worker watchdog (every ${WORKER_HEALTH_CHECK_INTERVAL_SECONDS}s) ..."
{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog started for ${BASE_URL}"
  while true; do
    sleep "$WORKER_HEALTH_CHECK_INTERVAL_SECONDS"
    if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      continue
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Worker health check failed; restarting Worker only."
    if ! restart_worker_with_refreshed_cookie; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Worker restart failed; will retry on the next health check."
    fi
  done
} >>"$WORKER_WATCHDOG_LOG_FILE" 2>&1 &
WORKER_WATCHDOG_PID=$!
echo "$WORKER_WATCHDOG_PID" >"$WORKER_WATCHDOG_PID_FILE"

(
  trap '' HUP
  while true; do
    COOKIE_REFRESH_WAIT_SECONDS=$(seconds_until_xueqiu_cookie_refresh)
    if [[ "$COOKIE_REFRESH_WAIT_SECONDS" -gt 0 ]]; then
      sleep "$COOKIE_REFRESH_WAIT_SECONDS"
    fi
    if refresh_xueqiu_cookie; then
      restart_worker_with_refreshed_cookie || echo "Local Worker restart after Xueqiu cookie refresh failed. Check ${LOG_FILE}." >&2
    else
      sleep "$XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS"
    fi
  done
) >>"$COOKIE_REFRESH_LOG_FILE" 2>&1 &
COOKIE_REFRESH_PID=$!
echo "$COOKIE_REFRESH_PID" >"$COOKIE_REFRESH_PID_FILE"

echo "Local site is ready."
echo "URL: ${BASE_URL}"
echo "Health: ${BASE_URL}/api/health"
echo "Log: ${LOG_FILE}"
echo "Cron config: ${PROJECT_ROOT}/wrangler.jsonc"
echo "Cron log: ${CRON_LOG_FILE}"
echo "Knowledge ingest log: ${KNOWLEDGE_INGEST_LOG_FILE}"
echo "Knowledge content URL: ${CONTENT_BASE_URL}"
echo "Knowledge report converter URL: ${KNOWLEDGE_REPORT_CONVERTER_URL}"
echo "Knowledge report conversion concurrency: ${KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY}"
echo "Knowledge content log: ${CONTENT_LOG_FILE}"
echo "HTTP proxy URL: ${HTTP_PROXY_URL}"
echo "HTTP fetch relay URL: ${HTTP_PROXY_RELAY_URL}"
echo "HTTP proxy domains: ${HTTP_PROXY_DOMAINS}"
echo "HTTP domain concurrency: ${HTTP_DOMAIN_CONCURRENCY}"
echo "HTTP request timeout: ${HTTP_REQUEST_TIMEOUT_MS}ms"
echo "LLM daily limit: ${LLM_DAILY_LIMIT}"
echo "Knowledge content PID: ${CONTENT_PID}"
echo "Macro fetch relay URL: ${MACRO_FETCH_RELAY_URL}"
echo "Macro fetch relay log: ${MACRO_FETCH_RELAY_LOG_FILE}"
echo "Macro fetch relay PID: ${MACRO_FETCH_RELAY_PID}"
echo "Worker PID: ${WORKER_PID}"
echo "Worker watchdog log: ${WORKER_WATCHDOG_LOG_FILE}"
echo "Worker watchdog PID: ${WORKER_WATCHDOG_PID}"
echo "Cron PID: ${CRON_PID}"
echo "Knowledge ingest scheduler PID: ${KNOWLEDGE_INGEST_PID:-not started}"
echo "Web Search package runner log: ${WEB_SEARCH_RUNNER_LOG_FILE}"
echo "Web Search package runner PID: ${WEB_SEARCH_RUNNER_PID}"
echo "Operating analysis runner log: ${OPERATING_ANALYSIS_RUNNER_LOG_FILE}"
echo "Operating analysis runner PID: ${OPERATING_ANALYSIS_RUNNER_PID}"
echo "Information processing runner log: ${INFORMATION_PROCESSING_RUNNER_LOG_FILE}"
echo "Information processing runner PID: ${INFORMATION_PROCESSING_RUNNER_PID}"
echo "Xueqiu cookie refresh interval: ${XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS}s"
echo "Xueqiu cookie refresh log: ${COOKIE_REFRESH_LOG_FILE}"
echo "Xueqiu cookie refresher PID: ${COOKIE_REFRESH_PID}"
