#!/usr/bin/env bash
set -euo pipefail

container=$(docker run --rm -d -p 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust --label abby.phase0.probe=true postgres:17-alpine)
cleanup() {
  docker stop "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mapped=$(docker port "$container" 5432/tcp)
port=${mapped##*:}
ready=false
for _ in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -p "$port" -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs --tail 20 "$container" >&2
  exit 1
fi

export DATABASE_URL="postgresql://postgres@127.0.0.1:$port/postgres"
export ABBY_ISOLATED_POSTGRES_PROBE=1
"$@"
