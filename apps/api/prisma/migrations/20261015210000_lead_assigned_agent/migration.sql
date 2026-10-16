-- AlterTable
ALTER TABLE "leads" ADD COLUMN "assigned_agent_id" UUID;

-- CreateIndex
CREATE INDEX "leads_assigned_agent_id_idx" ON "leads"("assigned_agent_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
