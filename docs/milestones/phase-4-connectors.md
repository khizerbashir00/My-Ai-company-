# Phase 4 — Lead source connector framework

**Scope:** Common connector interface, registry, BullMQ/Redis scan jobs, Hacker News (Algolia Search API) as the first end-to-end connector, scan history UI, manual import fallback, qualification handoff, tests.
**Date:** 16 Oct 2026.

## First connector: Hacker News Search API

| Item | Detail |
| --- | --- |
| **Source key** | `hacker_news` |
| **API** | Official HN Search API (Algolia): `https://hn.algolia.com/api` |
| **Endpoint used** | `GET https://hn.algolia.com/api/v1/search_by_date` |
| **Capabilities** | Full-text search, pagination (`page` / `hitsPerPage`), public stories + Ask HN (`tags=ask_hn,story`) |
| **Credentials** | None — public HTTP GET |
| **Commercial / terms posture** | Reads only public index content. No login, no CAPTCHA bypass, no scraping of login-protected pages. Stay within rate limits; do not bulk-exfiltrate the index. Contact authors only through channels they publish and your compliance rules allow. |
| **Quotas / rate limits** | Historical community guidance cites ~1000 requests/IP/hour. This connector paces pages (~350ms between), caps pages per scan (default 3, max 5), and retries 429/5xx with exponential backoff. |
| **Access method stored** | `OFFICIAL_API` |
| **Evidence stored** | `sourceUrl` (HN item URL), `externalId` (Algolia `objectID`), `postDate`, `discoveredAt`, raw snapshot (points, tags, etc.) |

### Setup

1. Ensure Postgres is migrated (`npm run db:deploy` in `apps/api`).
2. Seed (`npm run db:seed`) — creates `manual_import` + `hacker_news` with a default connection (`status=CONFIGURED`, default query for website/web-dev asks).
3. Optional but recommended: start Redis (`docker compose up -d redis`) and set `REDIS_URL=redis://localhost:6379` so scans run on BullMQ. Without Redis, scans still run **inline** in the API process.
4. Open **Sources** in the web app → configure query / max results / interval → **Run scan**.
5. New leads appear under **Leads** with HN source evidence; a qualification task is enqueued (`idempotencyKey=qualify-lead:<leadId>`).

### What is NOT connected

Reddit, Facebook, LinkedIn, X, and freelance marketplaces are **not** implemented. They must not be shown or claimed as working until a permitted connector ships and is tested with authorized credentials.

## Framework pieces

- `LeadSourceConnector` interface + `ConnectorRegistry`
- `httpGetJson` — timeouts, 429/5xx retry + backoff, AbortSignal
- `ScanService` — paginate → `LeadsService.ingestFromConnector` (idempotent on `externalId` / canonical URL) → qualification task
- `ScanQueueService` — BullMQ when Redis is up, else inline `setImmediate`
- `ScanSchedulerService` — interval-based enqueue from `Source.scanIntervalMinutes`
- API: `GET /sources`, `PATCH /sources/connections/:id`, `POST .../scan`, `GET /sources/scans`, `POST /sources/manual-import`
- Web: `/sources` connectors + scan history; statuses: Unconfigured / Unauthorized / Unavailable / Disabled / Error / Configured / Working / Manual fallback
- `CURRENT_EXECUTION_PHASE = 4`; tool `search_lead_sources` queues a scan for an implemented connector

## Tests

- Unit: HN `mapHit`, config validation, paginated mock fetch, HTTP retry/abort
- Unit: scan dedupe + failure marking
- E2E: list sources, mocked HN scan → lead + qualification task, second scan dedupes, manual import, viewer forbidden

Mock tests prove connector logic and idempotency. They are **not** proof of a live production integration — a live check requires calling the real HN Search API from an environment that can reach `hn.algolia.com`.
