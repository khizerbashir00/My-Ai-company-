import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScanQueueService } from '../sources/scan-queue.service';
import { TasksService } from '../tasks/tasks.service';
import { ControlLogService } from './control-core';

export const INTERRUPTED_MESSAGE = 'Interrupted by a server restart. Use Restart Failed (Control Center) or Run with AI to retry.';

export interface RecoveryReport {
  agentRunsFailed: number;
  tasksFailed: number;
  scanRunsFailed: number;
  scanRunsRequeued: number;
}

/**
 * Fixes work orphaned by a crash or redeploy. Without this, tasks/agent runs/scans stay RUNNING forever:
 * the task can never be retried (an open agent run looks like live execution) and the scan scheduler
 * skips that source permanently (it treats the stuck run as in progress).
 *
 * Runs once at boot, after the queue has connected. Assumes a single API process (see known limitations):
 * anything RUNNING at boot cannot belong to a live executor.
 */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);
  lastReport: (RecoveryReport & { at: string }) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly queue: ScanQueueService,
    private readonly log: ControlLogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.recover();
    } catch (err) {
      this.logger.error(`Startup recovery failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  async recover(): Promise<RecoveryReport> {
    const now = new Date();
    const report: RecoveryReport = { agentRunsFailed: 0, tasksFailed: 0, scanRunsFailed: 0, scanRunsRequeued: 0 };

    // 1. Open agent runs → FAILED (they block retries via hasActiveRun).
    const runs = await this.prisma.agentRun.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', errorMessage: INTERRUPTED_MESSAGE, finishedAt: now },
    });
    report.agentRunsFailed = runs.count;

    // 2. RUNNING tasks → FAILED through the state machine (history + audit + SSE), so Restart Failed can retry them.
    const stuck = await this.prisma.task.findMany({ where: { status: 'RUNNING' }, select: { id: true } });
    for (const t of stuck) {
      try {
        await this.tasks.transitionAs(t.id, { to: 'FAILED', message: INTERRUPTED_MESSAGE }, { type: 'SYSTEM' });
        report.tasksFailed += 1;
      } catch (err) {
        this.logger.warn(`Could not recover task ${t.id}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }

    // 3. Scans that were mid-flight → FAILED; their connection gets the error so the Sources page shows it.
    const runningScans = await this.prisma.sourceScanRun.findMany({ where: { status: 'RUNNING' }, select: { id: true, connectionId: true } });
    for (const s of runningScans) {
      await this.prisma.$transaction([
        this.prisma.sourceScanRun.update({ where: { id: s.id }, data: { status: 'FAILED', finishedAt: now, errorMessage: INTERRUPTED_MESSAGE } }),
        this.prisma.sourceConnection.update({ where: { id: s.connectionId }, data: { lastError: INTERRUPTED_MESSAGE } }),
      ]);
      report.scanRunsFailed += 1;
    }

    // 4. Scans that never started: make sure a job exists (inline jobs die with the process).
    const queued = await this.prisma.sourceScanRun.findMany({ where: { status: 'QUEUED' }, select: { id: true } });
    for (const q of queued) {
      try {
        if (await this.queue.ensureQueued(q.id)) report.scanRunsRequeued += 1;
      } catch (err) {
        this.logger.warn(`Could not re-queue scan ${q.id}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }

    this.lastReport = { ...report, at: now.toISOString() };
    const total = report.agentRunsFailed + report.tasksFailed + report.scanRunsFailed + report.scanRunsRequeued;
    if (total > 0) {
      this.logger.warn(`Startup recovery: ${JSON.stringify(report)}`);
      await this.log.log({
        level: 'WARN',
        action: 'recovery.completed',
        message: `Recovered work interrupted by a restart: ${report.tasksFailed} task(s) and ${report.scanRunsFailed} scan(s) marked failed (retryable), ${report.scanRunsRequeued} queued scan(s) re-queued.`,
        data: { ...report },
      });
    }
    return report;
  }
}
