#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ "${1:-}" = "--review" ]; then
  shift
  exec ./start.sh --review-featured-report "$@"
fi
exec ./start.sh --prepare-featured-report "$@"
