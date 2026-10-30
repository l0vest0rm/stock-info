#!/bin/sh
set -eu

cd "$(dirname "$0")"

exec ./start-rust.sh --maintenance cleanup-docs --local --apply
