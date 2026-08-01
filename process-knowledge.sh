#!/bin/sh
set -eu

cd "$(dirname "$0")"

node scripts/fetch-eastmoney-reports.mjs "$@"
node scripts/fetch-cls-news.mjs "$@"
npm run process:knowledge -- "$@"
