#!/bin/sh
set -eu

cd "$(dirname "$0")"

exec node scripts/import-knowledge-docs-remote-latest.mjs
