import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScanService } from './scan.service';

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
  ) {}

  get jobsMode(): JobsMode {
    return this.mode;
  }

  get redisConfigured(): boolean {
    return Boolean(this.config.redisUrl);
  }

  async onModuleInit(): Promise<void> {
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
          await this.scan.executeRun(job.data.scanRunId);
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
          attempts: 2,
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

    // Inline: do not block the HTTP response.
    setImmediate(() => {
      void this.scan.executeRun(scanRunId).catch((err) => {
        this.logger.warn(`Inline scan ${scanRunId} failed: ${err instanceof Error ? err.message : 'error'}`);
      });
    });
    return { mode: 'inline', bullJobId: null };
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
