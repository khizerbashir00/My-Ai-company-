# Phase 2 milestone report — AI execution engine

**Scope:** OpenAI provider, structured outputs, General Manager planning, controlled task runner, registry-validated tools, agent runs / usage persistence, approval gate for external side effects.
**Result:** complete and verified against automated tests. Date: 16 Oct 2026.

## Features implemented

- Official `openai` SDK in `apps/api` with a provider interface (`AiProvider` / `OpenAiProvider`) and Responses API structured outputs (`zodTextFormat` + Zod re-validation).
- Server-only credentials via `AppConfigService` (`openaiApiKey`, `resolveModel`). `GET /api/system/status` still returns only `{ provider, apiKeyConfigured, routineModel, advancedModel }`.
- `POST /api/orchestration/tasks/:id/run` claims a QUEUED (or retriable FAILED) task, runs the assigned agent, cascades to children when requested.
- General Manager / manager plans validated against the live org chart (`GmPlannerService`); steps become `delegate_task` subtasks with idempotency keys.
- Tool executor checks the server registry (unknown tools, missing permissions, phase availability) and creates `Approval` rows for approval-locked side effects instead of executing them.
- Persists `agent_runs`, `tool_calls`, `usage_records`, task `output`, status transitions (actor `AGENT`), and SSE `task.updated` / `task.created` through existing services.
- Bounded timeout (60s), compare-and-set claim (duplicate execution → `deduplicated: true`), retry limit respected, cancellation preserved.
- Workers that need source connectors return `outcome: "blocked"` — no fabricated leads.
- UI: **Run with AI** on task detail when the task is assigned and queued; Settings copy updated.

## Commands executed (verification)

```
npm run typecheck     # API + web: clean
npm test              # 4 suites, 40 tests passed
npm run test:e2e      # includes ai-execution.e2e-spec (12 tests) + existing suites
npm run test:ui       # Playwright
```

## Missing credentials

- Live OpenAI calls need `OPENAI_API_KEY` and `OPENAI_MODEL` (optional `OPENAI_MODEL_ADVANCED`) in `apps/api/.env`.
- Automated tests use `FakeAiProvider` and never call the network.

## Known limitations

- Lead discovery, outreach send, publishing, and paid campaigns remain unimplemented executors (phases 3–5); requesting them is denied or parked as an approval.
- No background worker yet — runs are request-scoped (BullMQ arrives in Phase 4).
- Model picker UI still edits env on the server only.
- Session revocation and multi-user admin UI remain as in Phase 1.
