#!/bin/bash
set -u

payload="$(cat)"
[ -n "$payload" ] || exit 0

session_id=$(printf '%s' "$payload" | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(s).session_id || ""); } catch {} });')
[ -n "$session_id" ] || exit 0

host="${CONVERSE_HOST:-127.0.0.1}"
port="${CONVERSE_PORT:-45839}"
line=$(curl -fsS --connect-timeout 1 --max-time 2 "http://${host}:${port}/v1/status?owner_id=${session_id}" 2>/dev/null || true)
[ -n "$line" ] || exit 0
printf '%s\n' "$line"
