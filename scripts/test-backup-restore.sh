#!/usr/bin/env bash
# Non-destructive smoke test of backup -> restore against the *local* compose Postgres
# using a temporary database. Does not touch production volumes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PGUSER="${POSTGRES_USER:-ai_company}"
TMP_DB="hq_backup_smoke_$(date +%s)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
  docker compose exec -T postgres psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"${TMP_DB}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Ensuring local postgres is up..."
docker compose up -d postgres
docker compose exec -T postgres pg_isready -U "$PGUSER" -d ai_company >/dev/null

echo "Creating temp DB ${TMP_DB}..."
docker compose exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TMP_DB}\";"
docker compose exec -T postgres psql -U "$PGUSER" -d "$TMP_DB" -v ON_ERROR_STOP=1 -c "CREATE TABLE smoke(id int primary key, note text); INSERT INTO smoke VALUES (1, 'hello-backup');"

DUMP="$TMP_DIR/smoke.sql.gz"
echo "Dumping..."
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$TMP_DB" --no-owner | gzip -c > "$DUMP"

echo "Dropping and recreating empty DB..."
docker compose exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE \"${TMP_DB}\";"
docker compose exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TMP_DB}\";"

echo "Restoring..."
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U "$PGUSER" -d "$TMP_DB" -v ON_ERROR_STOP=1

NOTE="$(docker compose exec -T postgres psql -U "$PGUSER" -d "$TMP_DB" -Atc "SELECT note FROM smoke WHERE id=1;")"
# trim CR from docker TTY
NOTE="$(printf '%s' "$NOTE" | tr -d '\r')"
if [[ "$NOTE" != "hello-backup" ]]; then
  echo "FAIL: expected hello-backup, got: [$NOTE]" >&2
  exit 1
fi

echo "OK: backup/restore smoke test passed (temp DB cleaned up)."
