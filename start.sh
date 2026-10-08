#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
[ -f .env.local ] || cp .env.example .env.local
# 体验用は本番ビルドで起動する。dev モードだと初回の対話で API ルートのコンパイル待ち（十数秒）が入り、首包超時に引っかかりうる
npx next build
npx next start -p "${PORT:-3000}"
