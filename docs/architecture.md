# Architecture

## Shape

```
Browser (React, apps/web) ──/api──► NestJS API (apps/api) ──► PostgreSQL
        ▲                                │
        └──── SSE /api/events/stream ────┘          Redis + BullMQ workers (Phase 4)
                                                    OpenAI via provider interface (Phase 2)
```

The browser only ever talks to its own origin. Sessions are an httpOnly, `SameSite=Strict` JWT cookie, so page scripts never see a token and cross-site requests can't ride the session.

## API modules

| Module | Responsibility |
| --- | --- |
| `config` | Validates env at boot (zod); typed accessors; never serializes secrets |
| `prisma` | Prisma 7 client over `@prisma/adapter-pg` |
| `auth` | Login/logout/me/change-password; global `AuthGuard` (authenticate everything unless `@Public()`, reload the user each request so deactivation and role changes apply immediately, enforce `@Roles()`) |
| `audit` | Append-only audit log with secret redaction; read API for CEO/admin |
| `departments` | Departments with task stats; org chart built from `agent_definitions.parent_id` |
| `agents` | Agent definitions, tool/permission registry, CEO-only edits |
| `tasks` | Task CRUD, state machine, dependencies, idempotency, cascading cancel |
| `dashboard` | Metrics from database counts, each with a written definition |
| `events` | In-process event bus → SSE stream |
| `ai` | OpenAI provider boundary, model resolution, structured-output validation (secrets never leave the server) |
| `orchestration` | Task runner, GM plan validation, registry-checked tool execution, agent runs / usage; accepts an external abort signal |
| `control` | Control Center: persisted workflow switches (`workflow_controls`), operations log (`control_events`), background AI task worker, startup recovery, Start/Stop/Restart Failed/Connect All |
| `social` | OAuth 2.0 code flow for LinkedIn, Facebook, Reddit and X (state + PKCE in `oauth_states`), AES-256-GCM-encrypted tokens in `social_accounts`, refresh, verify, revoke |

Guards run in order: rate limiter (120/min default, 5/min for login and password change) → authentication/RBAC. A global validation pipe strips and rejects unknown fields. A global exception filter returns `{statusCode, error, message, requestId}` and never leaks stack traces, SQL or secrets; unexpected errors are logged server-side with the same request ID.

## Roles and permissions

- **People**: `CEO` (everything, including agent configuration), `ADMIN` (operate tasks, read audit), `VIEWER` (read-only).
- **AI agents** are rows in `agent_definitions`, not model instances. Each has instructions, a model tier (`ROUTINE`/`ADVANCED`, mapped to env-configured models, optional per-agent override), an output token limit, tools and permissions.
- `src/agents/registry.ts` is the only source of tools and permissions an agent can ever have. There is no shell, filesystem or SQL tool. The API rejects unknown names, tools whose permission isn't held, and removing a permission a tool still needs.
- Human-only permissions (`deals.confirm`, `permissions.manage`) can never be granted to an agent — so the General Manager cannot grant itself anything.
- Approval-locked permissions (sending messages, publishing, paid campaigns, sharing sensitive files, bulk delete, customer commitments, confirming deals) are always stored with `requires_approval = true`, regardless of what the request says.

## Task state machine

```
QUEUED ──► RUNNING ──► COMPLETED
  │          │  ▲
  │          ▼  │
  │   AWAITING_APPROVAL
  │          │
  │          ▼
  │        FAILED ──► QUEUED   (retry while attempts < maxAttempts)
  ▼
CANCELLED   (from any non-terminal state; cascades to unfinished subtasks)
```

Rules enforced server-side (`src/tasks/task-state-machine.ts`, unit-tested):

- Only the edges above are legal; `COMPLETED` and `CANCELLED` are terminal and read-only.
- `QUEUED → RUNNING` increments `attempts`, and is blocked while any dependency is unfinished.
- `→ FAILED` requires a reason, stored as a safe `error_message`.
- Retries stop at `max_attempts`; the CEO can raise the limit (never below attempts already made).
- Transitions are compare-and-set (`UPDATE … WHERE status = <expected>`), so two concurrent actors can't both win.
- An `idempotency_key` makes repeated creation return the existing task instead of duplicating work.
- Every change writes a `task_events` row (history) and an `audit_logs` row (accountability) in the same transaction.

Kinds: `GOAL` (for the General Manager), `DEPARTMENT_TASK` (manager), `WORKER_TASK` (worker). The kind and department are derived from the assigned agent and inconsistent combinations are rejected.

## Data model

All 23 tables from the brief exist from the first migration, so later phases add behavior without restructuring:

- **Org**: `users`, `departments`, `agent_definitions`, `agent_permissions`
- **Execution**: `tasks`, `task_dependencies`, `task_events`, `agent_runs`, `tool_calls`, `usage_records`
- **Leads**: `sources`, `source_connections`, `leads`, `lead_sources`, `lead_scores`
- **Outreach**: `outreach_messages`, `outreach_events`
- **Marketing**: `campaigns`, `campaign_assets`
- **Governance**: `approvals`, `notifications`, `audit_logs`, `projects`

Notable constraints: lead de-duplication is per source on `(source_id, external_id)` and `(source_id, canonical_url)` — leads are never merged on name similarity. Notifications are unique on `(user_id, dedupe_key)`. A project is unique per lead. `source_connections.credentials_env` stores the *name* of an env var, never a credential. Budgets are only stored when stated by the prospect.

## Dashboard metrics

`GET /api/dashboard/metrics` returns counts plus a `definitions` object explaining each number (shown in the UI under "How these are counted"). Lead metrics use leads discovered in the date range; event metrics use when the event happened. Marketing reach/engagement report `measured: false` until an analytics source exists — nothing is estimated.

## Control Center

`/api/control/*` drives real backend state:

| Button | What the server does |
| --- | --- |
| Start All | Persists all workflows ON, resumes the BullMQ scan worker, runs a scheduler tick now, starts the AI task worker (refused with a reason when no AI key is set) |
| Stop All | Persists all workflows OFF, aborts the in-flight AI call (task → FAILED, retryable), aborts running scans, pauses the BullMQ worker and cancels queued scans. Nothing is deleted; queued tasks stay queued |
| Restart Failed | FAILED tasks → QUEUED via the state machine's retry edge (respecting max attempts, enabled agent), re-scans connections whose last scan failed, re-tests social connections in ERROR. Failed email sends are never retried automatically |
| Connect All | Starts the next pending OAuth flow; the callback returns with `connectAll=1` and the UI continues until every configured platform is connected |

The AI task worker picks QUEUED tasks whose agent is enabled and whose dependencies are complete (highest priority first) and runs them through the same `TaskRunnerService` as "Run with AI", without cascade — subtasks are picked up as their own jobs. Every action writes `audit_logs` and `control_events` and emits `control.updated` over SSE.

**Startup recovery.** Before this, a crash or redeploy left tasks, agent runs and scans `RUNNING` forever: the task could never be retried (its open run looked live) and the scheduler skipped that source permanently. At boot `RecoveryService` marks them FAILED with a clear reason and re-enqueues QUEUED scans whose job was lost.

## Social OAuth

The callback route is public by necessity: the session cookie is `SameSite=Strict`, so browsers don't send it on the cross-site redirect back from the provider. The caller is identified by a single-use `state` (only its SHA-256 is stored), valid for 10 minutes and bound to the platform; the redirect target is always `<PUBLIC_APP_URL>/control`. Tokens are encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`), never returned by the API, and redacted from logs. A connected Reddit account is used by the Reddit lead-source connector.

## Live updates

Services emit `task.created`, `task.updated` and `agent.updated` events carrying IDs only. The SSE endpoint is authenticated by the session cookie; the browser refetches through normal authorized endpoints. The bus is in-process today; when BullMQ workers run in a separate process (Phase 4) it will be bridged through Redis pub/sub.
