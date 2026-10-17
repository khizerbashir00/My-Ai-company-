# Known production limitations

Honest constraints as of the production-readiness cut.

| Area | Limitation |
| --- | --- |
| Process model | API, BullMQ worker, and schedulers run in **one** Nest process. Prefer **one** API replica. |
| SSE | In-process event bus — does not fan out across multiple API instances. |
| Throttling | In-memory Nest throttler — limits are per process, not global Redis-backed. |
| Ad networks / social publish | Social accounts connect through official OAuth (Control Center) with encrypted tokens, refresh and live verification. HQ still marks publish/launch after CEO approval; **no** automated ad spend or social posting yet — the stored tokens are the foundation for that. |
| Control Center | Start/Stop state is persisted in the DB and honored by one process. The AI task worker runs one task at a time. Stop All aborts the in-flight AI call; that task is marked FAILED (retryable) and uses one attempt. |
| Startup recovery | At boot, anything still RUNNING is marked FAILED (retryable). Correct for the single-replica deployment; with several API replicas it would interrupt a sibling's work — add leases before scaling out. |
| Analytics | Live GA/etc. unavailable until credentials + sync adapter; imports work today. |
| AI cost | Dashboard USD figures are **ESTIMATES** from token metadata + list prices — not OpenAI invoices. |
| Session revocation | No server-side session versioning; changing password does not invalidate other cookies until expiry. |
| Seed in prod | Blocked unless `ALLOW_PROD_SEED=1`; still not a substitute for proper user admin UI. |
| Horizontal scale | Not validated; Redis pub/sub for events and a separate worker entrypoint are future work. |
| Browser e2e in CI | Playwright covers core flows locally; Marketing/Notifications/Reports are API-e2e covered. |

## What production checks still require you

Docker image builds, Compose up on a VPS, real DNS/TLS issuance, off-site backup storage, and live OpenAI/Resend delivery are **not** executed by the agent. Run the commands in [production.md](./production.md) on your server when ready.
