#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./start-rust.sh --publish-featured-report "$@"
