#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
[ -f .env.local ] || cp .env.example .env.local
npx next dev -p "${PORT:-3000}"
