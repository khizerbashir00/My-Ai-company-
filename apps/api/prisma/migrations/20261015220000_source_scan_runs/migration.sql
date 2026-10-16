-- CreateEnum
CREATE TYPE "ScanRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('SCHEDULE', 'MANUAL', 'AGENT');

-- CreateTable
CREATE TABLE "source_scan_runs" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "status" "ScanRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "ScanTrigger" NOT NULL DEFAULT 'MANUAL',
    "bull_job_id" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "items_found" INTEGER NOT NULL DEFAULT 0,
    "items_created" INTEGER NOT NULL DEFAULT 0,
    "items_deduped" INTEGER NOT NULL DEFAULT 0,
    "items_skipped" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_scan_runs_connection_id_created_at_idx" ON "source_scan_runs"("connection_id", "created_at");

-- CreateIndex
CREATE INDEX "source_scan_runs_status_created_at_idx" ON "source_scan_runs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "source_scan_runs" ADD CONSTRAINT "source_scan_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
