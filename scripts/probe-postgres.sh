#!/usr/bin/env bash
set -euo pipefail

npm run db:migrate
npm run db:migrate -- down
npm run db:migrate
node scripts/probe-upgrade.ts
node scripts/probe-write-stop-upgrade.ts
npm run db:generate
ABBY_LEDGER=postgres npm run test:postgres
