#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ "$#" -ne 0 ]; then
  echo "process-knowledge-local-full.sh does not accept arguments" >&2
  exit 2
fi

exec ./start-rust.sh --process-knowledge-existing --local-full
