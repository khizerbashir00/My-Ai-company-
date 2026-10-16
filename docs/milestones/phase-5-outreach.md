# Phase 5 — Approval-based outreach & follow-ups

**Scope:** Email provider interface (Resend), CEO approval before send, reply ingest/classification, follow-up schedules with pause/stop, in-app notifications, client briefing enrichment, confirmed-deal → project.
**Date:** 16 Oct 2026.
**Note:** Product phase gate `CURRENT_EXECUTION_PHASE = 5`. (Connector framework remains documented as phase-4-connectors.)

## Email provider: Resend

| Item | Detail |
| --- | --- |
| **Interface** | `EmailProvider` (`apps/api/src/email/email.types.ts`) |
| **Implementation** | `ResendEmailProvider` — HTTP `POST https://api.resend.com/emails` |
| **Auth** | API key via `RESEND_API_KEY` (not OAuth). Create a key in the Resend dashboard for the CEO’s workspace. |
| **From address** | `EMAIL_FROM` must be on a **verified domain** in Resend — this is the CEO-authorized mailbox. |
| **Optional** | `EMAIL_REPLY_TO`, `RESEND_WEBHOOK_SECRET` for inbound webhook auth |
| **Docs** | https://resend.com/docs/send-with-nodejs · https://resend.com/docs/dashboard/domains/introduction |

### Setup

1. Create a Resend account; verify the sending domain.
2. In `apps/api/.env`:
   ```
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=re_...
   EMAIL_FROM=ceo@your-verified-domain.com
   EMAIL_REPLY_TO=ceo@your-verified-domain.com   # optional
   RESEND_WEBHOOK_SECRET=...                     # optional but required in production for inbound
   ```
3. Restart the API. Settings → Email shows **Ready** only when provider + key + from are set.
4. Point Resend inbound / webhook (if used) to `POST /api/webhooks/email/inbound`.

**Do not claim live email delivery or reply monitoring until the provider is configured and a real send/reply has been tested.** Without configuration, approve-and-send fails clearly with a 503.

## Behaviour

1. Draft outreach on a lead → **Request send approval** → `Approval` (`SEND_EXTERNAL_MESSAGE`).
2. CEO opens **Approvals** review screen (recipient, subject, body, lead, source, status) → Approve → send via Resend, or Reject.
3. Message stores `providerMessageId`, timestamps, `deliveryStatus`, `lastProviderError`.
4. Inbound replies (webhook) match by `In-Reply-To` / contact email; ambiguous matches flagged for review.
5. AI + heuristic classification: positive / negative / neutral / unsubscribe / demo request / needs review. AI must not invent commitments or final pricing.
6. Unsubscribe / DNC / pause → cancel scheduled follow-ups; opt-out recorded.
7. Follow-ups: schedule with duplicate prevention; when due → request send approval (never silent auto-send).
8. Notifications (deduped): positive reply, demo request, pending approval, etc.
9. Briefing: company, original request, conversation history, questions, demo prep.
10. **Won** requires `POST /leads/:id/confirm-deal` with scope + deal value → creates `Project`.
11. Audit log on request/send/decide/pause/confirm; pause/stop for scheduled outreach.

## Tests

- Unit: reply classification heuristics
- E2E: approval enforcement, provider failure, opt-out + follow-up cancel, notification dedupe, confirm-deal, pause

Fake/mocked provider tests prove workflow safety. They are **not** proof of live Resend delivery.
