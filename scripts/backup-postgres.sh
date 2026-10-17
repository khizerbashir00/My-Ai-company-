#!/usr/bin/env bash
# Backup Postgres from docker compose (prod or local). Never prints connection passwords.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
OUT_DIR="${BACKUP_DIR:-$ROOT/storage/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
DB="${POSTGRES_DB:-ai_company}"
PGUSER="${POSTGRES_USER:?POSTGRES_USER required}"
FILE="$OUT_DIR/${DB}_${STAMP}.sql.gz"

echo "Creating compressed logical backup -> $FILE"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  pg_dump -U "$PGUSER" -d "$DB" --no-owner --format=plain \
  | gzip -c > "$FILE"

# Keep a small sidecar with non-secret metadata only
cat > "${FILE}.meta" <<EOF
createdAtUtc=$STAMP
database=$DB
composeFile=$(basename "$COMPOSE_FILE")
bytes=$(wc -c < "$FILE" | tr -d ' ')
EOF

echo "OK: backup written ($(wc -c < "$FILE" | tr -d ' ') bytes)"
echo "$FILE"
