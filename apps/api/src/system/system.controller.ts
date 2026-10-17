import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import IORedis from 'ioredis';
import { Public } from '../common/auth.decorators';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class SystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Process liveness — no dependency checks (for Docker HEALTHCHECK / kill switches). */
  @Public()
  @SkipThrottle()
  @Get('health/live')
  live() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  /** Readiness — database required; Redis checked when REDIS_URL is set. */
  @Public()
  @SkipThrottle()
  @Get('health/ready')
  async ready() {
    const checks: Record<string, 'up' | 'down' | 'skipped'> = { database: 'down', redis: 'skipped' };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', checks, message: 'Database unavailable' });
    }

    if (this.config.redisUrl) {
      const redis = new IORedis(this.config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        lazyConnect: true,
      });
      try {
        await redis.connect();
        const pong = await redis.ping();
        checks.redis = pong === 'PONG' ? 'up' : 'down';
      } catch {
        checks.redis = 'down';
        throw new ServiceUnavailableException({ status: 'degraded', checks, message: 'Redis unavailable' });
      } finally {
        redis.disconnect();
      }
    }

    return { status: 'ok', checks, time: new Date().toISOString() };
  }

  /** Back-compat alias used by older monitors and Playwright. */
  @Public()
  @SkipThrottle()
  @Get('health')
  async health() {
    return this.ready();
  }

  /** Ops snapshot for the CEO UI — booleans and counts only, never secrets. */
  @Get('system/status')
  async status() {
    const sources = await this.prisma.source.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        platform: true,
        accessMethod: true,
        isEnabled: true,
        connections: {
          select: { status: true, lastSuccessAt: true, lastError: true },
          take: 1,
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const [tasksFailed, tasksAwaiting, pendingApprovals, unreadCeo] = await Promise.all([
      this.prisma.task.count({ where: { status: 'FAILED' } }),
      this.prisma.task.count({ where: { status: 'AWAITING_APPROVAL' } }),
      this.prisma.approval.count({ where: { status: 'PENDING' } }),
      this.prisma.notification.count({
        where: { readAt: null, user: { role: 'CEO', isActive: true } },
      }),
    ]);

    return {
      ai: this.config.aiStatus,
      email: this.config.emailStatus,
      redisConfigured: Boolean(this.config.redisUrl),
      limits: {
        taskDefaultMaxAttempts: this.config.taskDefaultMaxAttempts,
        scanJobAttempts: this.config.scanJobAttempts,
        throttleLimit: this.config.throttleLimit,
        aiDailyEstimatedUsdBudget: this.config.aiDailyEstimatedUsdBudget,
      },
      monitoring: {
        tasksFailed,
        tasksAwaitingApproval: tasksAwaiting,
        pendingApprovals,
        unreadCeoNotifications: unreadCeo,
      },
      sources: sources.map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        platform: s.platform,
        accessMethod: s.accessMethod,
        isEnabled: s.isEnabled,
        connectionStatus: s.connections[0]?.status ?? null,
        lastSuccessAt: s.connections[0]?.lastSuccessAt ?? null,
        lastError: s.connections[0]?.lastError ?? null,
      })),
      environment: this.config.nodeEnv,
    };
  }
}
