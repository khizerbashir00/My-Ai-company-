import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ScanQueueService } from './scan-queue.service';
import { ScanService } from './scan.service';

const TICK_MS = 60_000;

/**
 * Periodically enqueues scans for connections whose scanIntervalMinutes has elapsed.
 * Skips disabled / unconfigured / unauthorized connections and those already QUEUED/RUNNING.
 */
@Injectable()
export class ScanSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScanSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorRegistry,
    private readonly scan: ScanService,
    private readonly queue: ScanQueueService,
  ) {}

  onModuleInit(): void {
    // Avoid open handles in e2e/unit Nest apps.
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logger.warn(`Scheduler tick failed: ${err instanceof Error ? err.message : 'error'}`));
    }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests. */
  async tick(): Promise<number> {
    const connections = await this.prisma.sourceConnection.findMany({
      where: {
        status: { not: 'DISABLED' },
        source: { isEnabled: true, scanIntervalMinutes: { gt: 0 } },
      },
      include: { source: true },
    });

    let enqueued = 0;
    const now = Date.now();

    for (const c of connections) {
      const connector = this.connectors.get(c.source.key);
      if (!connector || !connector.isAuthorized(process.env)) continue;
      const config = (c.config as Record<string, unknown> | null) ?? {};
      if (connector.validateConfig(config).length) continue;

      const intervalMs = c.source.scanIntervalMinutes * 60_000;
      const anchor = c.lastSuccessAt ?? c.lastSyncAt ?? c.createdAt;
      if (now - anchor.getTime() < intervalMs) continue;

      const active = await this.prisma.sourceScanRun.count({
        where: { connectionId: c.id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (active > 0) continue;

      try {
        const runId = await this.scan.createRun(c.id, 'SCHEDULE');
        await this.queue.enqueue(runId);
        enqueued += 1;
      } catch (err) {
        this.logger.warn(`Could not schedule scan for ${c.source.key}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }

    return enqueued;
  }
}
