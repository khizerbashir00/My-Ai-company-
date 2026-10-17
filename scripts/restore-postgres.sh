#!/usr/bin/env bash
# Restore a gzipped pg_dump into the compose Postgres service.
# WARNING: replaces schema/data in the target database. Requires typed confirmation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <backup.sql.gz>" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
DB="${POSTGRES_DB:-ai_company}"
PGUSER="${POSTGRES_USER:?POSTGRES_USER required}"

echo "About to RESTORE into database '$DB' from:"
echo "  $BACKUP_FILE"
echo "This will overwrite existing data in that database."
read -r -p "Type the database name to confirm: " CONFIRM
if [[ "$CONFIRM" != "$DB" ]]; then
  echo "Confirmation mismatch - aborting." >&2
  exit 1
fi

echo "Restoring..."
gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1

echo "OK: restore finished. Restart API if it was running during restore:"
echo "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE restart api"
