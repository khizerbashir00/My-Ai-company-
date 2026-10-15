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
      select: { id: true, key: true, name: true, platform: true, accessMethod: true, isEnabled: true },
    });
    return { ai: this.config.aiStatus, sources, environment: this.config.nodeEnv };
  }
}
