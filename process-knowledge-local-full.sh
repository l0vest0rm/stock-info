#!/bin/sh
set -eu

cd "$(dirname "$0")"

exec node scripts/process-knowledge-local-full.mjs
