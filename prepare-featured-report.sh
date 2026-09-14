#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
export LLM_RUNTIME=local
mkdir -p data/local/featured-runtime
FEATURED_RUN_DIR=$(mktemp -d "$PWD/data/local/featured-runtime/prepare.XXXXXX")
trap 'rm -rf "$FEATURED_RUN_DIR"' EXIT
node_modules/.bin/esbuild scripts/prepare-featured-report.mjs --bundle --platform=node --format=esm --packages=external --outfile="$FEATURED_RUN_DIR/prepare.mjs" --log-level=error
export FEATURED_PROJECT_ROOT="$PWD"
node "$FEATURED_RUN_DIR/prepare.mjs" "$@"
