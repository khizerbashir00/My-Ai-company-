-- CreateTable
CREATE TABLE "ceo_reports" (
    "id" UUID NOT NULL,
    "period" "MarketingReportPeriod" NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "metrics_snapshot" JSONB NOT NULL,
    "generated_by_user_id" UUID,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ceo_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ceo_reports_period_period_start_idx" ON "ceo_reports"("period", "period_start");

-- CreateIndex
CREATE INDEX "ceo_reports_generated_at_idx" ON "ceo_reports"("generated_at");

-- AddForeignKey
ALTER TABLE "ceo_reports" ADD CONSTRAINT "ceo_reports_generated_by_user_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Metric-query indexes (attributed_campaign_id already indexed in marketing migration)
CREATE INDEX "leads_demo_scheduled_at_idx" ON "leads"("demo_scheduled_at");
CREATE INDEX "leads_lost_at_idx" ON "leads"("lost_at");
CREATE INDEX "outreach_messages_sent_at_idx" ON "outreach_messages"("sent_at");
