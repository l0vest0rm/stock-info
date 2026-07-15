#!/bin/sh
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SKILL_NAME="analyze-stock-earnings"
SOURCE_DIR="$REPO_ROOT/skills/$SKILL_NAME"
TARGET_ROOT="${CODEX_HOME:-$HOME/.codex}/skills"
TARGET_DIR="$TARGET_ROOT/$SKILL_NAME"

if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "missing skill source: $SOURCE_DIR/SKILL.md" >&2
  exit 1
fi

mkdir -p "$TARGET_ROOT"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$SOURCE_DIR"/. "$TARGET_DIR"/

echo "installed $SKILL_NAME to $TARGET_DIR"
