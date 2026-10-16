-- CreateEnum
CREATE TYPE "ResearchProjectStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "FindingKind" AS ENUM ('VERIFIED', 'SUGGESTION', 'ESTIMATE');
CREATE TYPE "ContentChannel" AS ENUM ('LINKEDIN', 'WEBSITE_ARTICLE', 'CASE_STUDY', 'LANDING_PAGE', 'EMAIL_CAMPAIGN', 'OTHER');
CREATE TYPE "ContentItemStatus" AS ENUM ('IDEA', 'SCHEDULED', 'DRAFTING', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED', 'CANCELLED');
CREATE TYPE "MarketingReportPeriod" AS ENUM ('DAILY', 'WEEKLY');
CREATE TYPE "AnalyticsSourceKind" AS ENUM ('MANUAL_IMPORT', 'CONFIGURED_INTEGRATION');

-- AlterTable leads
ALTER TABLE "leads" ADD COLUMN "attributed_campaign_id" UUID;

-- AlterTable campaigns
ALTER TABLE "campaigns" ADD COLUMN "channel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "campaigns" ADD COLUMN "audience" TEXT NOT NULL DEFAULT '';
ALTER TABLE "campaigns" ADD COLUMN "messaging" TEXT NOT NULL DEFAULT '';
ALTER TABLE "campaigns" ADD COLUMN "launched_at" TIMESTAMP(3);

-- AlterTable campaign_assets
ALTER TABLE "campaign_assets" ADD COLUMN "current_version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable brand_profiles
CREATE TABLE "brand_profiles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'default',
    "voice_guidelines" TEXT NOT NULL DEFAULT '',
    "services_offered" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "portfolio_notes" TEXT NOT NULL DEFAULT '',
    "approved_claims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "brand_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_profiles_key_key" ON "brand_profiles"("key");

-- CreateTable market_research_projects
CREATE TABLE "market_research_projects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "service_offering" TEXT NOT NULL,
    "target_customer_profile" TEXT NOT NULL DEFAULT '',
    "status" "ResearchProjectStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT NOT NULL DEFAULT '',
    "task_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "market_research_projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "market_research_projects_status_created_at_idx" ON "market_research_projects"("status", "created_at");
CREATE INDEX "market_research_projects_country_industry_idx" ON "market_research_projects"("country", "industry");

-- CreateTable competitor_reports
CREATE TABLE "competitor_reports" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "competitor_name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "researched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "task_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "competitor_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_reports_project_id_researched_at_idx" ON "competitor_reports"("project_id", "researched_at");

-- CreateTable competitor_sources
CREATE TABLE "competitor_sources" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "competitor_sources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_sources_report_id_idx" ON "competitor_sources"("report_id");

-- CreateTable research_findings
CREATE TABLE "research_findings" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "report_id" UUID,
    "claim" TEXT NOT NULL,
    "kind" "FindingKind" NOT NULL DEFAULT 'VERIFIED',
    "evidence_url" TEXT,
    "source_note" TEXT NOT NULL DEFAULT '',
    "researched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "research_findings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "research_findings_project_id_idx" ON "research_findings"("project_id");
CREATE INDEX "research_findings_report_id_idx" ON "research_findings"("report_id");

-- CreateTable content_items
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "channel" "ContentChannel" NOT NULL,
    "status" "ContentItemStatus" NOT NULL DEFAULT 'IDEA',
    "scheduled_for" TIMESTAMP(3),
    "campaign_id" UUID,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "content_items_status_scheduled_for_idx" ON "content_items"("status", "scheduled_for");
CREATE INDEX "content_items_channel_scheduled_for_idx" ON "content_items"("channel", "scheduled_for");

-- CreateTable content_versions
CREATE TABLE "content_versions" (
    "id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "change_note" TEXT NOT NULL DEFAULT '',
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "content_versions_content_item_id_version_key" ON "content_versions"("content_item_id", "version");
CREATE INDEX "content_versions_content_item_id_created_at_idx" ON "content_versions"("content_item_id", "created_at");

-- CreateTable campaign_asset_versions
CREATE TABLE "campaign_asset_versions" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "change_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_asset_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "campaign_asset_versions_asset_id_version_key" ON "campaign_asset_versions"("asset_id", "version");

-- CreateTable campaign_metric_imports
CREATE TABLE "campaign_metric_imports" (
    "id" UUID NOT NULL,
    "campaign_id" UUID,
    "source_kind" "AnalyticsSourceKind" NOT NULL,
    "source_name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_metric_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaign_metric_imports_campaign_id_imported_at_idx" ON "campaign_metric_imports"("campaign_id", "imported_at");

-- CreateTable campaign_metric_rows
CREATE TABLE "campaign_metric_rows" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "denominator" DECIMAL(18,4),
    "denominator_label" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "campaign_metric_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaign_metric_rows_import_id_idx" ON "campaign_metric_rows"("import_id");

-- CreateTable analytics_integrations
CREATE TABLE "analytics_integrations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_configured" BOOLEAN NOT NULL DEFAULT false,
    "credentials_env" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "analytics_integrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_integrations_key_key" ON "analytics_integrations"("key");

-- CreateTable marketing_reports
CREATE TABLE "marketing_reports" (
    "id" UUID NOT NULL,
    "period" "MarketingReportPeriod" NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "metrics_snapshot" JSONB NOT NULL,
    "generated_by_agent_id" UUID,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketing_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "marketing_reports_period_period_start_idx" ON "marketing_reports"("period", "period_start");

-- Indexes
CREATE INDEX "campaign_assets_status_idx" ON "campaign_assets"("status");
CREATE INDEX "leads_attributed_campaign_id_idx" ON "leads"("attributed_campaign_id");

-- FKs
ALTER TABLE "leads" ADD CONSTRAINT "leads_attributed_campaign_id_fkey" FOREIGN KEY ("attributed_campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "market_research_projects" ADD CONSTRAINT "market_research_projects_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "competitor_reports" ADD CONSTRAINT "competitor_reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "market_research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_reports" ADD CONSTRAINT "competitor_reports_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "competitor_sources" ADD CONSTRAINT "competitor_sources_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "competitor_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "market_research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "competitor_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "campaign_asset_versions" ADD CONSTRAINT "campaign_asset_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "campaign_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_metric_imports" ADD CONSTRAINT "campaign_metric_imports_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "campaign_metric_rows" ADD CONSTRAINT "campaign_metric_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "campaign_metric_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_reports" ADD CONSTRAINT "marketing_reports_generated_by_agent_id_fkey" FOREIGN KEY ("generated_by_agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
