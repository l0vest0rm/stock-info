#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./start-rust.sh --process-knowledge "$@"
