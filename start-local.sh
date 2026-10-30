#!/bin/sh
# The supported local application is the native Rust backend.
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/start-rust.sh" "$@"
