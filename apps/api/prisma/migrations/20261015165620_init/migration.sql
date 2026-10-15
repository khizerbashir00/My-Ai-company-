-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CEO', 'ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('GENERAL_MANAGER', 'MANAGER', 'WORKER');

-- CreateEnum
CREATE TYPE "ModelTier" AS ENUM ('ROUTINE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('GOAL', 'DEPARTMENT_TASK', 'WORKER_TASK');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('REQUESTED', 'DENIED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceAccessMethod" AS ENUM ('OFFICIAL_API', 'AUTHORIZED_FEED', 'APPROVED_INTEGRATION', 'MANUAL_IMPORT');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('UNCONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'QUALIFIED', 'DRAFT_READY', 'AWAITING_APPROVAL', 'CONTACTED', 'REPLIED', 'INTERESTED', 'DEMO_REQUESTED', 'DEMO_COMPLETED', 'NEGOTIATION', 'WON', 'LOST', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "IntentLabel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('EMAIL', 'LINKEDIN', 'REDDIT', 'X', 'FACEBOOK', 'MARKETPLACE', 'OTHER');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutreachEventType" AS ENUM ('DRAFT_CREATED', 'APPROVAL_REQUESTED', 'APPROVED', 'REJECTED', 'SENT', 'SEND_FAILED', 'REPLY_RECEIVED', 'FOLLOW_UP_DUE', 'OPT_OUT', 'BOUNCED', 'NOTE');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignAssetType" AS ENUM ('LINKEDIN_POST', 'CASE_STUDY', 'LANDING_PAGE', 'PORTFOLIO_DESCRIPTION', 'EDUCATIONAL', 'EMAIL', 'AD_COPY', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('SEND_EXTERNAL_MESSAGE', 'PUBLISH_CONTENT', 'LAUNCH_PAID_CAMPAIGN', 'SHARE_SENSITIVE_FILE', 'BULK_DELETE', 'CUSTOMER_COMMITMENT', 'CONFIRM_DEAL');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('HIGH_INTENT_LEAD', 'POSITIVE_REPLY', 'DEMO_REQUESTED', 'APPROVAL_REQUIRED', 'TASK_FAILED_REPEATEDLY', 'REPORT_READY', 'TASK_UPDATE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'IN_PROGRESS', 'ON_HOLD', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_definitions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AgentKind" NOT NULL,
    "department_id" UUID,
    "parent_id" UUID,
    "role" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "reporting_responsibilities" TEXT NOT NULL,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model_tier" "ModelTier" NOT NULL DEFAULT 'ROUTINE',
    "model_override" TEXT,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 2000,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_permissions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "kind" "TaskKind" NOT NULL DEFAULT 'DEPARTMENT_TASK',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "department_id" UUID,
    "assigned_agent_id" UUID,
    "parent_task_id" UUID,
    "created_by_id" UUID,
    "input" JSONB,
    "output" JSONB,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "idempotency_key" TEXT,
    "due_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "depends_on_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "TaskStatus",
    "to_status" "TaskStatus",
    "message" TEXT NOT NULL DEFAULT '',
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "actor_agent_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "task_id" UUID,
    "agent_id" UUID NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error_message" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" UUID NOT NULL,
    "agent_run_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "result" JSONB,
    "status" "ToolCallStatus" NOT NULL DEFAULT 'REQUESTED',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "access_method" "SourceAccessMethod" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "compliance_notes" TEXT NOT NULL DEFAULT '',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scan_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_connections" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "config" JSONB,
    "credentials_env" TEXT,
    "cursor" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_url" TEXT,
    "website_url" TEXT,
    "country" TEXT,
    "industry" TEXT,
    "requirements" TEXT NOT NULL DEFAULT '',
    "requested_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budget_text" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "intent_label" "IntentLabel",
    "latest_score" INTEGER,
    "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
    "opted_out_at" TIMESTAMP(3),
    "demo_scheduled_at" TIMESTAMP(3),
    "deal_value" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "won_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),
    "lost_reason" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT,
    "url" TEXT NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "post_date" TIMESTAMP(3),
    "access_method" "SourceAccessMethod" NOT NULL,
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_scores" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "label" "IntentLabel" NOT NULL,
    "reasons" JSONB NOT NULL,
    "rubric_version" TEXT NOT NULL,
    "agent_run_id" UUID,
    "scored_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_messages" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "is_follow_up" BOOLEAN NOT NULL DEFAULT false,
    "parent_message_id" UUID,
    "scheduled_for" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_events" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "message_id" UUID,
    "type" "OutreachEventType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB,

    CONSTRAINT "outreach_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL DEFAULT '',
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "target_segments" JSONB,
    "messaging_concepts" JSONB,
    "success_metrics" JSONB,
    "budget_recommendation" DECIMAL(12,2),
    "budget_currency" TEXT NOT NULL DEFAULT 'USD',
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "task_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_assets" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "type" "CampaignAssetType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_for" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "action_type" "ApprovalActionType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "requested_by_agent_id" UUID,
    "task_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "lead_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "deal_value" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_id" UUID,
    "start_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "actor_agent_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "data" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "agent_run_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "departments_key_key" ON "departments"("key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_definitions_key_key" ON "agent_definitions"("key");

-- CreateIndex
CREATE INDEX "agent_definitions_department_id_idx" ON "agent_definitions"("department_id");

-- CreateIndex
CREATE INDEX "agent_definitions_parent_id_idx" ON "agent_definitions"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_permissions_agent_id_permission_key" ON "agent_permissions"("agent_id", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_idempotency_key_key" ON "tasks"("idempotency_key");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_department_id_idx" ON "tasks"("department_id");

-- CreateIndex
CREATE INDEX "tasks_assigned_agent_id_idx" ON "tasks"("assigned_agent_id");

-- CreateIndex
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks"("parent_task_id");

-- CreateIndex
CREATE INDEX "tasks_created_at_idx" ON "tasks"("created_at");

-- CreateIndex
CREATE INDEX "task_dependencies_depends_on_id_idx" ON "task_dependencies"("depends_on_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_task_id_depends_on_id_key" ON "task_dependencies"("task_id", "depends_on_id");

-- CreateIndex
CREATE INDEX "task_events_task_id_created_at_idx" ON "task_events"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_task_id_idx" ON "agent_runs"("task_id");

-- CreateIndex
CREATE INDEX "agent_runs_agent_id_started_at_idx" ON "agent_runs"("agent_id", "started_at");

-- CreateIndex
CREATE INDEX "tool_calls_agent_run_id_idx" ON "tool_calls"("agent_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "sources_key_key" ON "sources"("key");

-- CreateIndex
CREATE UNIQUE INDEX "source_connections_source_id_label_key" ON "source_connections"("source_id", "label");

-- CreateIndex
CREATE INDEX "leads_stage_idx" ON "leads"("stage");

-- CreateIndex
CREATE INDEX "leads_intent_label_idx" ON "leads"("intent_label");

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE INDEX "leads_contact_email_idx" ON "leads"("contact_email");

-- CreateIndex
CREATE INDEX "lead_sources_lead_id_idx" ON "lead_sources"("lead_id");

-- CreateIndex
CREATE INDEX "lead_sources_canonical_url_idx" ON "lead_sources"("canonical_url");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_source_id_external_id_key" ON "lead_sources"("source_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_source_id_canonical_url_key" ON "lead_sources"("source_id", "canonical_url");

-- CreateIndex
CREATE INDEX "lead_scores_lead_id_created_at_idx" ON "lead_scores"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "outreach_messages_lead_id_idx" ON "outreach_messages"("lead_id");

-- CreateIndex
CREATE INDEX "outreach_messages_status_idx" ON "outreach_messages"("status");

-- CreateIndex
CREATE INDEX "outreach_events_lead_id_occurred_at_idx" ON "outreach_events"("lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "outreach_events_type_occurred_at_idx" ON "outreach_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaign_assets_campaign_id_idx" ON "campaign_assets"("campaign_id");

-- CreateIndex
CREATE INDEX "approvals_status_created_at_idx" ON "approvals"("status", "created_at");

-- CreateIndex
CREATE INDEX "approvals_entity_type_entity_id_idx" ON "approvals"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "projects_lead_id_key" ON "projects"("lead_id");

-- CreateIndex
CREATE INDEX "projects_confirmed_at_idx" ON "projects"("confirmed_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "usage_records_created_at_idx" ON "usage_records"("created_at");

-- CreateIndex
CREATE INDEX "usage_records_provider_model_idx" ON "usage_records"("provider", "model");

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_agent_id_fkey" FOREIGN KEY ("actor_agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_scored_by_id_fkey" FOREIGN KEY ("scored_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "outreach_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "outreach_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_fkey" FOREIGN KEY ("requested_by_agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_agent_id_fkey" FOREIGN KEY ("actor_agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
