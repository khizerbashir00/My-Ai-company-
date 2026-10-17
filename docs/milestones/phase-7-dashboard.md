# Phase 7 — CEO dashboard, reporting & notifications

**Scope:** Complete Overview metrics, notification center, CEO daily/weekly reports, AI usage summary, SSE hardening, pagination/indexes, tests.
**Date:** 16 Oct 2026.
**Note:** User “PHASE 6 dashboard” maps here. Marketing automation remains `phase-6-marketing.md` (`CURRENT_EXECUTION_PHASE = 6`).

## Metrics (all DB-backed)

| Metric | Definition |
| --- | --- |
| Leads discovered / qualified / high-intent | Count by `createdAt` (+ optional `sourceId`) |
| Outreach drafts | `DRAFT` or `AWAITING_APPROVAL` messages created in range |
| Drafts awaiting approval | Pending approvals: send / publish / paid launch (current, not date-filtered) |
| Messages sent / replies | `sentAt` / distinct `REPLY_RECEIVED` leads |
| Interested / demos / negotiations / meetings | Stage or `demoScheduledAt` rules in `METRIC_DEFINITIONS` |
| Won / lost / revenue | Confirmed `Project` / `lostAt` / sum `dealValue` |
| Marketing campaigns / published assets / attributed leads / imports | Counted status + HQ publish marks |
| Marketing performance | Only when analytics integration (non-manual) or metric imports exist |
| Tasks by status / completion rate / pending approvals | Task + Approval tables |
| AI usage | `UsageRecord` token sums; USD is **ESTIMATE** from list prices |

Filters: `from`, `to`, `sourceId` (leads/sales), `departmentId` (tasks).

## Unavailable without integrations

Documented in API `marketing.performance.unavailable` and Overview copy:

| Metric | Why unavailable |
| --- | --- |
| Live reach / engagement / CTR / cost-per-lead | Needs configured analytics (e.g. GA credentials) or imported reports |
| Actual ad-network spend | No ad-network automation; HQ only stores budget recommendations + imported figures |
| Actual OpenAI invoices | Only token metadata is recorded; USD on the dashboard is an **ESTIMATE**, not billing |
| Cost for unknown models | No rate table entry → shown as Unavailable |

## Notifications

- `GET /api/notifications`, `GET /api/notifications/unread-count`, mark read / read-all
- Unique `(userId, dedupeKey)` prevents duplicates
- UI: **Notifications** nav + unread badge; links open the related record
- SSE: `notification.created` events are filtered to the authenticated user

## CEO reports

- `GET/POST /api/dashboard/reports`, `GET /api/dashboard/reports/:id`
- Snapshot of the same metrics endpoint for the period; saved in `ceo_reports`
- UI: **Reports** page

## Indexes added

`leads.demo_scheduled_at`, `leads.lost_at`, `leads.attributed_campaign_id`, `outreach_messages.sent_at`, plus CEO report indexes.

## Tests

- Dashboard e2e: known fixture counts, AI usage, reports, notification isolation, SSE auth + user-scoped notifications
- Unit: `estimateUsd` ESTIMATE vs UNAVAILABLE
