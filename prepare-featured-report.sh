#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ "${1:-}" = "--review" ]; then
  shift
  exec ./start-rust.sh --review-featured-report "$@"
fi
exec ./start-rust.sh --prepare-featured-report "$@"
