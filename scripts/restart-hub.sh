#!/usr/bin/env bash
# Restart the hub so it reloads .env, then confirm platforms are healthy.
# Finds the running `bun run src/index.ts` process, kills it, relaunches detached.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2-); PORT=${PORT:-8137}

# Kill any process listening on the hub port (the running hub).
PID=$(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
if [ -n "${PID:-}" ]; then
  echo "Stopping hub (pid $PID)…"
  kill "$PID" 2>/dev/null
  sleep 1
fi

echo "Starting hub…"
setsid nohup bun run src/index.ts > hub.log 2>&1 < /dev/null &
sleep 3

echo "Platforms:"
curl -s -m 20 "http://127.0.0.1:$PORT/platforms?check=true" \
  | bun -e 'const d=JSON.parse(await new Response(Bun.stdin.stream()).text()); for(const p of d.platforms) console.log(`  ${p.platform.padEnd(9)} enabled=${p.enabled} healthy=${p.healthy} ${p.detail??""}`);' \
  || echo "  (hub not responding yet — check hub.log)"
