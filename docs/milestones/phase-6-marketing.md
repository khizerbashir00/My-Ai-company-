# Phase 6 — Marketing automation

**Scope:** Market research projects, competitor reports with source attribution, content calendar & versioned drafts, brand voice, campaign planning & asset library, CEO approval for publish/paid launch, metrics via imports/integrations only, attributed leads, conversion denominators, Marketing Manager daily/weekly reports, GM → Marketing Manager → worker delegation.
**Date:** 16 Oct 2026.
**Note:** Product phase gate `CURRENT_EXECUTION_PHASE = 6`. (User “PHASE 5 marketing” maps here; connectors = phase 4, outreach = phase 5.)

## Boundaries

| AI (Sales + Marketing) | CEO (you) |
| --- | --- |
| Research, content drafts, campaign plans, analytics reporting | Demos, deal closing, software development after Won |
| Request publish / paid-launch approvals | Approve or reject before anything is marked published/active |
| Import or read configured analytics | Provide real exports / credentials — HQ never invents figures |

**Never invented:** competitor prices, campaign results, engagement figures, business facts without evidence.

**Publish / spend:** HQ only marks `PUBLISHED` / `ACTIVE` after CEO approval. No ad-network or social posting automation.

## Data model (Prisma)

- `BrandProfile` — voice, services, approved portfolio claims (singleton `default`)
- `MarketResearchProject` + `CompetitorReport` + `CompetitorSource` + `ResearchFinding` (`VERIFIED` | `SUGGESTION` | `ESTIMATE`)
- `ContentItem` + `ContentVersion` (calendar + draft history)
- `Campaign` + `CampaignAsset` + `CampaignAssetVersion`
- `CampaignMetricImport` + `CampaignMetricRow` (explicit `denominator` / `denominatorLabel` for rates)
- `AnalyticsIntegration` — `manual_import` always configured; GA stub until credentials
- `MarketingReport` — DAILY / WEEKLY with `metricsSnapshot.denominators` + caveats
- `Lead.attributedCampaignId` — source-attributed outcomes when recorded

## API (`/api/marketing`)

| Area | Endpoints |
| --- | --- |
| Brand | `GET/PATCH /brand` |
| Research | `GET/POST /research`, `GET /research/:id`, `POST .../competitors`, `POST .../findings` |
| Content | `GET/POST /content`, `GET /content/:id`, `POST .../drafts`, `POST .../request-publish` |
| Campaigns | `GET/POST /campaigns`, `GET /campaigns/:id`, `GET .../outcomes`, `POST .../assets`, `POST /assets/:id/versions`, `POST .../request-launch` |
| Metrics | `POST /metrics/import`, `POST /attribution`, `GET /analytics`, `GET /integrations` |
| Reports | `GET/POST /reports`, `GET /reports/:id`, `POST /reports/generate` |

Approvals: `PUBLISH_CONTENT`, `LAUNCH_PAID_CAMPAIGN` (same Approvals UI as outreach).

## Agents & tools

- **GM** delegates to Marketing Manager; Marketing Manager delegates to research / competitor / content planning / writing / campaign planning / analytics workers.
- Tools (phase ≥ 6): `fetch_public_page`, `create_content_draft`, `request_publish_content`, `create_campaign_proposal`, `request_launch_paid_campaign`, `read_analytics`, `generate_report`.
- Task status, retries, failure reporting, and audit history use the existing task runner + `audit_logs`.

## UI

**Marketing** nav → tabs: Research, Content, Campaigns, Reports, Brand. Overview shows published assets, campaigns, attributed leads, metric imports (no estimated performance).

## Setup

1. `cd apps/api && npx prisma migrate deploy && npm run db:seed`
2. Configure brand voice/services/approved claims under Marketing → Brand.
3. Import real metric exports via Marketing → Campaign detail (or wait for a configured analytics integration).
4. Approve publish/launch requests under **Approvals**.

## Tests

E2E (`test/marketing.e2e-spec.ts`): research-source attribution, draft versioning, publish/launch approval enforcement, campaign metrics + denominators, report generation.

Unit: tool authorization for marketing tools in current phase.
