#!/bin/sh
set -eu

cd "$(dirname "$0")"

node scripts/fetch-eastmoney-reports.mjs "$@"
npm run process:knowledge -- "$@"
