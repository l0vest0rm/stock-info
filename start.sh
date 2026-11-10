#!/bin/sh
# Native Rust application. Gracefully replace only this checkout's old server.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNTIME_DIR="${LOCAL_RUNTIME_DIR:-$HOME/Library/Application Support/stock-info}"
if [ -d "$RUNTIME_DIR.install-lock" ]; then
  echo 'Runtime installation in progress; no commands started.' >&2
  exit 1
fi
# After cutover, maintenance must use the same DB, not the preserved old copy.
if [ "$#" -gt 0 ] && [ "${1:-}" != "--build-only" ] && [ "${LOCAL_RUN_FROM_CHECKOUT:-0}" != 1 ] && [ -f "$RUNTIME_DIR/.stock-info-runtime" ]; then
  if [ "$(cat "$RUNTIME_DIR/.stock-info-runtime")" != "$PWD" ]; then
    echo 'Runtime belongs to another checkout; set LOCAL_RUNTIME_DIR explicitly.' >&2
    exit 1
  fi
  exec "$RUNTIME_DIR/start.sh" "$@"
fi
. ./scripts/local-runtime-env.sh
# Only server startup installs/copies durable state.
INSTALL_RUNTIME=0
BUILD_ONLY=0
if [ "$#" -eq 0 ]; then INSTALL_RUNTIME=1; fi
if [ "${1:-}" = "--build-only" ]; then
  if [ "$#" -ne 1 ]; then echo '--build-only takes no other arguments' >&2; exit 1; fi
  INSTALL_RUNTIME=1; BUILD_ONLY=1; shift
fi
if [ "$INSTALL_RUNTIME" -eq 0 ]; then
  ACQUISITION_RUNTIME_ENV="${LOCAL_ACQUISITION_RUNTIME_ENV:-data/local/acquisition-runtime.env}"
  if [ -f "$ACQUISITION_RUNTIME_ENV" ]; then . "$ACQUISITION_RUNTIME_ENV"; fi
fi
case "${1:-}" in --help|-h) ;; *)
  npm run build:prompts
  if [ "$INSTALL_RUNTIME" -eq 1 ] || [ "${1:-}" = "--review-featured-report" ]; then npm run build:web; fi
  ;;
esac
cargo build --locked --manifest-path backend/Cargo.toml
# Node is build tooling only: Cargo metadata locates external target directories.
# Exec the native binary directly so no Cargo process or build lock remains.
TARGET_DIR=$(cargo metadata --locked --no-deps --format-version 1 --manifest-path backend/Cargo.toml | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).target_directory))')
if [ "$INSTALL_RUNTIME" -eq 1 ]; then
  # Package the helper as managed code, not durable data copied only on first install.
  CAPTURE_MANIFEST=$(cargo metadata --locked --format-version 1 --manifest-path backend/Cargo.toml | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const p=JSON.parse(s).packages.find(p=>p.name==="app-capture-sdk");if(!p)process.exit(1);process.stdout.write(p.manifest_path)})')
  cargo build --locked --manifest-path "$CAPTURE_MANIFEST" --bin app-capture-host
  CAPTURE_TARGET=$(cargo metadata --locked --no-deps --format-version 1 --manifest-path "$CAPTURE_MANIFEST" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).target_directory))')
  CAPTURE_BINARY="$CAPTURE_TARGET/debug/app-capture-host"
  # Build before shutdown; failed compilation must leave the old service intact.
  # Both roots are owned by this checkout; validate both ports before any signal.
  node scripts/install-local-runtime.mjs "$PWD" "$RUNTIME_DIR" "$TARGET_DIR/debug/stock-info-local" --check
  LOCAL_RUNTIME_DIR="$RUNTIME_DIR" node scripts/prepare-local-ports.mjs
  node scripts/install-local-runtime.mjs "$PWD" "$RUNTIME_DIR" "$TARGET_DIR/debug/stock-info-local" --install "$CAPTURE_BINARY"
  if [ "$BUILD_ONLY" -eq 1 ]; then exit 0; fi
  exec "$RUNTIME_DIR/start.sh" "$@"
fi
exec "$TARGET_DIR/debug/stock-info-local" "$@"
