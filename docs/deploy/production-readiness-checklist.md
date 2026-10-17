# Production readiness checklist

Use before the first public cutover. Check items only after you have verified them yourself on the target host.

## Security

- [ ] `.env.production` exists on the server with mode `600`; not in Git
- [ ] `JWT_SECRET` ≥ 32 random characters (unique per environment)
- [ ] Strong `POSTGRES_PASSWORD` (not `local_dev_only`)
- [ ] `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://<HQ_DOMAIN>`
- [ ] Session cookie Secure + SameSite=Strict observed in browser DevTools over HTTPS
- [ ] No secrets in Docker images, client JS bundles, or log samples
- [ ] Firewall: only 80/443 (and SSH) exposed; Postgres/Redis not public

## DNS / TLS

- [ ] DNS A/AAAA points to the VPS
- [ ] `https://HQ_DOMAIN` serves the app with a valid certificate
- [ ] `https://HQ_DOMAIN/api/health/ready` returns `status: ok`

## Data

- [ ] `prisma migrate deploy` applied (entrypoint or manual) — no `migrate reset`
- [ ] CEO seeded once with `ALLOW_PROD_SEED=1`
- [ ] Backup script succeeds; off-site copy confirmed
- [ ] Restore procedure rehearsed on a non-prod volume or via `scripts/test-backup-restore.sh`

## Runtime

- [ ] Compose services healthy: `postgres`, `redis`, `api`, `web`, `caddy`
- [ ] Redis AOF enabled; API `REDIS_URL` set
- [ ] Single API replica (until workers/SSE are multi-instance ready)
- [ ] `LOG_FORMAT=json` shipped to your log store (optional)
- [ ] Task failure + approval notifications visible in HQ

## Integrations (optional until needed)

- [ ] `OPENAI_API_KEY` + `OPENAI_MODEL` set and Settings shows AI ready
- [ ] Resend domain verified; `EMAIL_FROM` matches
- [ ] Optional `AI_DAILY_ESTIMATED_USD_BUDGET` understood as **estimate**, not billing

## Known limitations

See [known-limitations.md](./known-limitations.md).
