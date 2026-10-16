import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AiUsage } from '../ai/ai.types';

@Injectable()
export class RunsService {
  constructor(private readonly prisma: PrismaService) {}

  async start(params: {
    taskId: string;
    agentId: string;
    provider: string;
    model: string;
    input: Record<string, unknown>;
  }) {
    return this.prisma.agentRun.create({
      data: {
        taskId: params.taskId,
        agentId: params.agentId,
        status: 'RUNNING',
        provider: params.provider,
        model: params.model,
        input: params.input as Prisma.InputJsonValue,
      },
    });
  }

  async succeed(runId: string, output: Record<string, unknown>, usage: AiUsage) {
    const run = await this.prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { model: true, provider: true } });
    await this.prisma.$transaction([
      this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: 'SUCCEEDED',
          output: output as Prisma.InputJsonValue,
          finishedAt: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      }),
      this.prisma.usageRecord.create({
        data: {
          agentRunId: runId,
          provider: run.provider,
          model: run.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
      }),
    ]);
  }

  async fail(runId: string, errorMessage: string, usage?: AiUsage | null) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { model: true, provider: true } });
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        errorMessage: errorMessage.slice(0, 2000),
        finishedAt: new Date(),
        ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      },
    });
    if (usage && run) {
      await this.prisma.usageRecord.create({
        data: {
          agentRunId: runId,
          provider: run.provider,
          model: run.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
      });
    }
  }

  async hasActiveRun(taskId: string): Promise<boolean> {
    const n = await this.prisma.agentRun.count({ where: { taskId, status: 'RUNNING' } });
    return n > 0;
  }
}
