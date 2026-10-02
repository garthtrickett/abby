#!/usr/bin/env bash
set -euo pipefail

# One disposable PostgreSQL server; independent Node test files run with four
# workers. Globs include new standalone and signed embedded voice files.
npm run build:cliniko-admin >/dev/null
npm run db:migrate >/dev/null
ABBY_LEDGER=postgres node --test --test-concurrency=4 \
  test/voice/standalone-*.test.ts \
  test/voice/embedded-signed-*.test.ts \
  test/voice/cross-mode-signed-*.test.ts \
  test/voice/postgres-active-call-claims.test.ts \
  test/voice/twilio-ingress-server.test.ts \
  test/composition/embedded-knowledge-signed-voice.test.ts
