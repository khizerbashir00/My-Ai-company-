import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkflowStateService } from '../control/control-core';
import { EventsService } from '../events/events.service';
import { SCAN_STOPPED_MESSAGE, ScanService } from './scan.service';

export const SOURCE_SCAN_QUEUE = 'source-scans';

export type JobsMode = 'bullmq' | 'inline';

@Injectable()
export class ScanQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScanQueueService.name);
  private connection: IORedis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private mode: JobsMode = 'inline';

  constructor(
    private readonly config: AppConfigService,
    private readonly scan: ScanService,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly workflows: WorkflowStateService,
  ) {}

  private paused = false;

  get isPaused(): boolean {
    return this.paused;
  }

  get jobsMode(): JobsMode {
    return this.mode;
  }

  get redisConfigured(): boolean {
    return Boolean(this.config.redisUrl);
  }

  async onModuleInit(): Promise<void> {
    await this.setupWorker();
    // Honor a persisted Stop from the Control Center across restarts.
    await this.workflows.reload();
    if (!this.workflows.isEnabled('lead-source-scans')) await this.pause();
  }

  private async setupWorker(): Promise<void> {
    const url = this.config.redisUrl;
    if (!url) {
      this.logger.warn('REDIS_URL not set — source scans run inline in the API process (no BullMQ).');
      this.mode = 'inline';
      return;
    }

    try {
      this.connection = new IORedis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: true,
      });
      await this.connection.connect();
      await this.connection.ping();

      this.queue = new Queue(SOURCE_SCAN_QUEUE, { connection: this.connection });
      this.worker = new Worker(
        SOURCE_SCAN_QUEUE,
        async (job: Job<{ scanRunId: string }>) => {
          try {
            await this.scan.executeRun(job.data.scanRunId);
          } catch (err) {
            // A scan stopped from the Control Center must not be retried automatically by BullMQ.
            const run = await this.prisma.sourceScanRun.findUnique({ where: { id: job.data.scanRunId }, select: { errorMessage: true } });
            if (run?.errorMessage === SCAN_STOPPED_MESSAGE) throw new UnrecoverableError(SCAN_STOPPED_MESSAGE);
            throw err;
          }
        },
        {
          connection: this.connection.duplicate(),
          concurrency: 1,
        },
      );
      this.worker.on('failed', (job, err) => {
        this.logger.warn(`Scan job ${job?.id} failed: ${err.message}`);
      });
      this.mode = 'bullmq';
      this.logger.log('BullMQ source-scan worker ready.');
    } catch (err) {
      this.logger.warn(
        `Redis unavailable (${err instanceof Error ? err.message : 'error'}) — falling back to inline scans.`,
      );
      await this.teardownRedis();
      this.mode = 'inline';
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.teardownRedis();
  }

  /** Enqueue a scan run. Uses BullMQ when Redis is up; otherwise executes asynchronously in-process. */
  async enqueue(scanRunId: string): Promise<{ mode: JobsMode; bullJobId: string | null }> {
    if (this.mode === 'bullmq' && this.queue) {
      const job = await this.queue.add(
        'scan',
        { scanRunId },
        {
          jobId: scanRunId,
          attempts: this.config.scanJobAttempts,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
      await this.prisma.sourceScanRun.update({
        where: { id: scanRunId },
        data: { bullJobId: String(job.id) },
      });
      return { mode: 'bullmq', bullJobId: String(job.id) };
    }

    // Inline + paused (Stop All): leave it QUEUED; resume() runs it. Matches BullMQ's paused worker.
    if (this.paused) return { mode: 'inline', bullJobId: null };

    // Inline: do not block the HTTP response.
    setImmediate(() => {
      void this.scan.executeRun(scanRunId).catch((err) => {
        this.logger.warn(`Inline scan ${scanRunId} failed: ${err instanceof Error ? err.message : 'error'}`);
      });
    });
    return { mode: 'inline', bullJobId: null };
  }

  /** Stop pulling new scan jobs (BullMQ worker.pause). Waiting jobs stay in Redis until resumed or cancelled. */
  async pause(): Promise<void> {
    this.paused = true;
    if (this.worker) await this.worker.pause(true);
  }

  async resume(): Promise<void> {
    this.paused = false;
    if (this.worker) {
      this.worker.resume();
      return;
    }
    // Inline mode: run anything that was queued while paused.
    const queued = await this.prisma.sourceScanRun.findMany({ where: { status: 'QUEUED' }, select: { id: true } });
    for (const r of queued) await this.enqueue(r.id);
  }

  /** Live counts from Redis when BullMQ is active. */
  async queueCounts(): Promise<Record<string, number> | null> {
    if (!this.queue) return null;
    try {
      return await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    } catch {
      return null;
    }
  }

  /** Cancel scan runs that have not started yet (DB + Redis). Returns how many were cancelled. */
  async cancelQueued(reason: string): Promise<number> {
    const queued = await this.prisma.sourceScanRun.findMany({ where: { status: 'QUEUED' }, select: { id: true, connectionId: true, bullJobId: true } });
    let cancelled = 0;
    for (const run of queued) {
      const res = await this.prisma.sourceScanRun.updateMany({
        where: { id: run.id, status: 'QUEUED' },
        data: { status: 'CANCELLED', finishedAt: new Date(), errorMessage: reason },
      });
      if (res.count !== 1) continue;
      cancelled += 1;
      if (this.queue && run.bullJobId) await this.queue.remove(run.bullJobId).catch(() => undefined);
      this.events.emit({ type: 'source.scan.updated', scanRunId: run.id, connectionId: run.connectionId, status: 'CANCELLED' });
    }
    return cancelled;
  }

  /**
   * After a restart, make sure a QUEUED run actually has a job behind it (inline runs are lost with the
   * process; Redis jobs may have been evicted). Returns true when it had to enqueue again.
   */
  async ensureQueued(scanRunId: string): Promise<boolean> {
    if (this.mode === 'bullmq' && this.queue) {
      const job = await this.queue.getJob(scanRunId);
      if (job) {
        const state = await job.getState();
        if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') return false;
        await job.remove().catch(() => undefined);
      }
    }
    await this.enqueue(scanRunId);
    return true;
  }

  private async teardownRedis(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.connection?.disconnect();
    this.worker = null;
    this.queue = null;
    this.connection = null;
  }
}
