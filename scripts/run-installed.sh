#!/bin/sh
# Standalone launcher: no checkout, Cargo, npm or Node at runtime.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -d "$PWD.install-lock" ]; then
  echo 'Runtime installation in progress; retry after it completes.' >&2
  exit 1
fi
ACQUISITION_RUNTIME_ENV="${LOCAL_ACQUISITION_RUNTIME_ENV:-data/local/acquisition-runtime.env}"
# Set the managed default before legacy local config's conditional assignments.
# Explicit caller overrides remain supported; the SDK rejects removable paths.
export APP_CAPTURE_HOST="${APP_CAPTURE_HOST:-$PWD/bin/app-capture-host}"
if [ -f "$ACQUISITION_RUNTIME_ENV" ]; then . "$ACQUISITION_RUNTIME_ENV"; fi
. ./scripts/local-runtime-env.sh
exec ./bin/stock-info-local "$@"
