#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/local/featured-runtime
FEATURED_RUN_DIR=$(mktemp -d "$PWD/data/local/featured-runtime/publish.XXXXXX")
trap 'rm -rf "$FEATURED_RUN_DIR"' EXIT
node_modules/.bin/esbuild scripts/publish-featured-report.mjs --bundle --platform=node --format=esm --packages=external --outfile="$FEATURED_RUN_DIR/publish.mjs" --log-level=error
export FEATURED_PROJECT_ROOT="$PWD"
node "$FEATURED_RUN_DIR/publish.mjs" "$@"
