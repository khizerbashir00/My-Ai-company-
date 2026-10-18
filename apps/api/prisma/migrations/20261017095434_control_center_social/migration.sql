-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('LINKEDIN', 'FACEBOOK', 'REDDIT', 'X');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "ControlEventLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "external_account_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "profile_url" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "expires_at" TIMESTAMP(3),
    "refresh_expires_at" TIMESTAMP(3),
    "metadata" JSONB,
    "connected_by_id" UUID,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified_at" TIMESTAMP(3),
    "last_refreshed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "user_id" UUID NOT NULL,
    "code_verifier_enc" TEXT,
    "connect_all" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_controls" (
    "key" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL,
    "updated_by_id" UUID,
    "last_started_at" TIMESTAMP(3),
    "last_stopped_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_controls_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "control_events" (
    "id" UUID NOT NULL,
    "level" "ControlEventLevel" NOT NULL DEFAULT 'INFO',
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_platform_key" ON "social_accounts"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "control_events_created_at_idx" ON "control_events"("created_at");
