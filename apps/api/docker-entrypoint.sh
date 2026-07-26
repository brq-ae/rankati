#!/bin/sh
set -e

# Wait for Postgres to actually accept connections before migrating.
#
# compose's `depends_on: {db: {condition: service_healthy}}` covers a cold `up`, but not
# every restart path — and `migrate deploy` against a database that is up but not yet
# listening fails the container for no good reason. So: retry briefly, then fail LOUDLY
# and let Docker's restart policy try again. A hang would be worse than an exit (ADR 0044).
MAX_WAIT=30
i=0
until node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge "$MAX_WAIT" ]; then
    echo "entrypoint: database unreachable after ${MAX_WAIT}s — exiting so Docker restarts us" >&2
    exit 1
  fi
  sleep 1
done
echo "entrypoint: database reachable after ${i}s"

# `migrate deploy` applies committed migrations only. It never generates a migration and
# never prompts — the only safe migration command for an unattended container (ADR 0045).
echo "entrypoint: applying migrations"
./node_modules/.bin/prisma migrate deploy

exec "$@"
