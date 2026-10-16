import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth.decorators';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class SystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Liveness + database check for Docker/uptime monitors. Reveals nothing sensitive. */
  @Public()
  @SkipThrottle()
  @Get('health')
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
    return { status: 'ok', time: new Date().toISOString() };
  }

  /** Which sources and AI settings are configured — booleans and model names only, never keys. */
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
    return {
      ai: this.config.aiStatus,
      email: this.config.emailStatus,
      redisConfigured: Boolean(this.config.redisUrl),
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
