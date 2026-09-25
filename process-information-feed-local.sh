#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${LLM_RUNTIME:-}" == "production" ]]; then
  echo 'Information feed tagging is unavailable in production LLM runtime.' >&2
  exit 1
fi
export LLM_RUNTIME=local
exec node scripts/information-feed.mjs "$@"
