#!/bin/sh
set -eu
# Apply pending migrations without resetting data, then start the API.
if [ "${RUN_MIGRATIONS_ON_START:-1}" = "1" ]; then
  echo "Applying Prisma migrations (deploy — non-destructive)…"
  npx prisma migrate deploy
fi
exec "$@"
