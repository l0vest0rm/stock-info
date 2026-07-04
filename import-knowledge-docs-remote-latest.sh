#!/bin/sh
set -eu

cd "$(dirname "$0")"

# Remote imports spend most of their time uploading content to R2 and then
# flushing large SQL batches to D1, so use faster defaults unless overridden.
: "${KNOWLEDGE_CONTENT_UPLOAD_CONCURRENCY:=24}"
: "${KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES:=2000000}"
export KNOWLEDGE_CONTENT_UPLOAD_CONCURRENCY
export KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES

exec node scripts/import-knowledge-docs-remote-latest.mjs
