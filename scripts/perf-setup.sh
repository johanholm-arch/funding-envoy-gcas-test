#!/usr/bin/env bash
# Builds the performance database: migrate, seed, scenario, then PERF_REQUESTS (default 500,000) of history.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_ADMIN_URL="postgres://postgres@localhost:5432/fundingenvoy_perf?host=${PGHOST:-/tmp}"
export DATABASE_URL="postgres://fe_app:fe_app_dev@localhost:5432/fundingenvoy_perf?host=${PGHOST:-/tmp}"
export FE_TODAY=2027-04-02 FE_ASSISTANT=demo
psql -h "${PGHOST:-/tmp}" -U postgres -v ON_ERROR_STOP=1 -c "drop database if exists fundingenvoy_perf with (force)" -c "create database fundingenvoy_perf"
pnpm --filter @fe/db migrate
pnpm --filter @fe/api seed
pnpm --filter @fe/api scenario
(cd apps/api && npx tsx src/perf/generate.ts)
