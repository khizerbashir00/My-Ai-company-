-- AlterEnum
ALTER TYPE "OutreachStatus" ADD VALUE 'SCHEDULED';

-- CreateEnum
CREATE TYPE "ReplyClassification" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNSUBSCRIBE', 'DEMO_REQUEST', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ReplyMatchStatus" AS ENUM ('MATCHED', 'AMBIGUOUS', 'UNMATCHED');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "outreach_paused_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outreach_messages"
  ADD COLUMN "recipient_email" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "delivery_status" TEXT,
  ADD COLUMN "last_provider_error" TEXT,
  ADD COLUMN "approval_id" UUID;

-- CreateIndex
CREATE INDEX "outreach_messages_status_scheduled_for_idx" ON "outreach_messages"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "outreach_messages_provider_message_id_idx" ON "outreach_messages"("provider_message_id");

-- CreateTable
CREATE TABLE "inbound_replies" (
    "id" UUID NOT NULL,
    "lead_id" UUID,
    "message_id" UUID,
    "from_email" TEXT NOT NULL,
    "to_email" TEXT,
    "subject" TEXT,
    "body_text" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "match_status" "ReplyMatchStatus" NOT NULL,
    "classification" "ReplyClassification" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "classification_reason" TEXT NOT NULL DEFAULT '',
    "candidate_lead_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_replies_provider_provider_message_id_key" ON "inbound_replies"("provider", "provider_message_id");

-- CreateIndex
CREATE INDEX "inbound_replies_lead_id_received_at_idx" ON "inbound_replies"("lead_id", "received_at");

-- CreateIndex
CREATE INDEX "inbound_replies_match_status_received_at_idx" ON "inbound_replies"("match_status", "received_at");

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "outreach_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
