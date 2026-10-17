-- CreateEnum
CREATE TYPE "TeamMessageAuthor" AS ENUM ('USER', 'AGENT');

-- CreateTable
CREATE TABLE "team_threads" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_messages" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_kind" "TeamMessageAuthor" NOT NULL,
    "user_id" UUID,
    "agent_id" UUID,
    "body" TEXT NOT NULL,
    "task_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_threads_last_message_at_idx" ON "team_threads"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "team_threads_agent_id_created_by_user_id_key" ON "team_threads"("agent_id", "created_by_user_id");

-- CreateIndex
CREATE INDEX "team_messages_thread_id_created_at_idx" ON "team_messages"("thread_id", "created_at");

-- AddForeignKey
ALTER TABLE "team_threads" ADD CONSTRAINT "team_threads_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_threads" ADD CONSTRAINT "team_threads_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "team_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
