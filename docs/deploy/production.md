# Production deployment (Linux VPS)

This guide deploys HQ with Docker Compose: Postgres, Redis (AOF), API, web (nginx), and Caddy (HTTPS).

**Do not commit secrets.** Use `.env.production` on the server only (gitignored).

## Architecture

```
Internet → Caddy (:443 TLS) → web (nginx) → /api → api (Nest)
                                ↓
                         postgres + redis (internal network only)
```

- Session cookies: `httpOnly`, `SameSite=Strict`, `Secure` when `NODE_ENV=production`
- Browser talks same-origin (`https://HQ_DOMAIN/api`); nginx proxies to the API
- Set `TRUST_PROXY=1` so rate limits and audit logs see the real client IP

## Prerequisites

- Linux VPS (Ubuntu 22.04+ recommended)
- Docker Engine + Compose plugin
- DNS **A/AAAA** for `HQ_DOMAIN` pointing at the VPS **before** first HTTPS request
- Open ports **80** and **443**

## 1. Install Docker

```bash
# Ubuntu example — follow current Docker docs for your distro
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
# log out/in, then:
docker compose version
```

## 2. Copy the project and secrets

```bash
git clone <your-private-repo-url> hq && cd hq
cp .env.production.example .env.production
# Edit .env.production:
#   HQ_DOMAIN, POSTGRES_PASSWORD, JWT_SECRET (openssl rand -base64 48)
#   CORS_ORIGINS=https://YOUR_DOMAIN
#   OPENAI_* / EMAIL_* when ready
chmod 600 .env.production
```

## 3. First boot (migrate + start)

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -fsS "https://$HQ_DOMAIN/api/health/ready"
```

Migrations run on API start via `prisma migrate deploy` (**non-destructive** — never uses `migrate reset` in production).

## 3b. Social connections (LinkedIn, Facebook, Reddit, X)

1. Set `PUBLIC_APP_URL=https://YOUR_DOMAIN` (exactly the address you open HQ at — `https://`, no trailing slash) and
   `TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)` in `.env.production`. Keep the key stable; changing it makes stored
   tokens unreadable and you would have to reconnect each platform.
2. Register these redirect URLs in each developer console (they are also shown, with a Copy button, in
   **Control Center → Social connections → Setup steps**):
   - `https://YOUR_DOMAIN/api/social/linkedin/callback`
   - `https://YOUR_DOMAIN/api/social/facebook/callback`
   - `https://YOUR_DOMAIN/api/social/reddit/callback`
   - `https://YOUR_DOMAIN/api/social/x/callback`
3. Fill the client IDs/secrets (`LINKEDIN_*`, `FACEBOOK_*`, `REDDIT_*`, `X_*`) and restart the API:
   `docker compose -f docker-compose.prod.yml --env-file .env.production up -d api`
4. Sign in as the CEO → **Control Center** → **Connect** (or **Connect All**) → approve on each platform.
   Then press **Test** on each card: it calls the platform's identity API with the stored token.

Platform approvals you may need: LinkedIn "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect" products;
Meta App Review + Business Verification for `pages_*` permissions (admins/testers work before review); Reddit
Responsible Builder Policy approval for new OAuth apps; a paid X API tier for posting.

## 4. Bootstrap the CEO account (once)

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec \
  -e NODE_ENV=production -e ALLOW_PROD_SEED=1 \
  -e CEO_EMAIL='you@example.com' -e CEO_NAME='Your Name' -e CEO_PASSWORD='your-long-password' \
  api node dist/database/seed-cli.js
```

Seed refuses `NODE_ENV=production` unless `ALLOW_PROD_SEED=1`. It does **not** overwrite an existing CEO password.

## 5. DNS and SSL

1. Create DNS **A** (and **AAAA** if IPv6) for `HQ_DOMAIN` → VPS IP.
2. Wait for propagation.
3. Caddy obtains certificates from Let’s Encrypt automatically on first HTTPS hit.
4. Force HTTPS is default in the Caddyfile.

Manual Nginx alternative: terminate TLS yourself, proxy to `web:80`, set `TRUST_PROXY=1`, and omit the `caddy` service.

## 6. Environment separation

| Env | Purpose |
| --- | --- |
| `apps/api/.env` + `docker compose` (dev) | Local API/web on host; Postgres/Redis in Compose |
| `TEST_DATABASE_URL` (`*test*` name) | Automated e2e only — wiped |
| `.env.production` + `docker-compose.prod.yml` | Production |

## 7. Updates (zero data loss)

```bash
cd hq
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
# API entrypoint runs: prisma migrate deploy
curl -fsS "https://$HQ_DOMAIN/api/health/ready"
```

## 8. Rollback

1. `git checkout <previous-good-sha>`
2. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
3. If a migration was the problem: restore DB from backup **before** re-applying newer migrations (see below). Prisma does not auto-rollback SQL.

## 9. Backups

```bash
chmod +x scripts/backup-postgres.sh scripts/restore-postgres.sh scripts/test-backup-restore.sh
COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.production ./scripts/backup-postgres.sh
# → storage/backups/<db>_<timestamp>.sql.gz
```

Schedule daily via cron:

```bash
0 3 * * * cd /path/to/hq && COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.production ./scripts/backup-postgres.sh >> /var/log/hq-backup.log 2>&1
```

Copy `.sql.gz` files off-box (S3, another VPS, etc.).

### Restore

```bash
COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.production \
  ./scripts/restore-postgres.sh storage/backups/ai_company_YYYYMMDDT….sql.gz
# Type the database name to confirm
docker compose -f docker-compose.prod.yml --env-file .env.production restart api
```

### Verified locally

`./scripts/test-backup-restore.sh` creates a temporary database on the **local** Compose Postgres, dumps, restores, and asserts data — it does not touch production volumes.

## 10. Redis

Production Compose enables AOF (`appendonly yes`, `appendfsync everysec`) for BullMQ durability. Redis is not published to the host. Source scans use BullMQ when `REDIS_URL` is set (default in prod compose).

**Limitation:** API and scan worker currently share one process. Run a **single API replica** unless you accept duplicate scheduler ticks / in-process SSE fan-out limits.

## 11. Health, logs, monitoring

| Check | URL |
| --- | --- |
| Liveness | `GET /api/health/live` |
| Readiness (DB + Redis) | `GET /api/health/ready` |
| Ops snapshot (auth) | `GET /api/system/status` → `monitoring.*` |

Logs: set `LOG_FORMAT=json`. Task max-retry failures notify the CEO in-app. Optional `AI_DAILY_ESTIMATED_USD_BUDGET` sends a deduped estimate alert (not invoices).

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api
```

## 12. Secret management

- Never bake secrets into images or the client bundle
- Prefer file permissions `600` on `.env.production`
- Rotate `JWT_SECRET` only with a planned re-login for all users
- Rotate DB password by updating Compose env and recreating the `postgres`/`api` services carefully

## 13. Rate limits & auth

- Global throttle: `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` (default 120/min)
- Login / password change: 5/min
- All routes authenticated except health, login, and documented public webhooks

## Exact command cheat sheet

```bash
# Start
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# Status
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -fsS https://YOUR_DOMAIN/api/health/ready

# Backup / restore
COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.production ./scripts/backup-postgres.sh
COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.production ./scripts/restore-postgres.sh path/to/backup.sql.gz

# Stop (volumes retained)
docker compose -f docker-compose.prod.yml --env-file .env.production down
```
