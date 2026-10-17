import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { estimateUsd } from './ai-usage';

const INTERVAL_MS = 15 * 60_000;

/**
 * Periodically compares today's recorded AI usage to an optional estimated USD budget.
 * Alerts are ESTIMATE-based — not OpenAI invoices.
 */
@Injectable()
export class BudgetAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BudgetAlertService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (this.config.aiDailyEstimatedUsdBudget == null) return;
    if (this.config.nodeEnv === 'test') return;
    this.timer = setInterval(() => {
      void this.checkDailyBudget().catch((err) =>
        this.logger.warn(`Budget check failed: ${err instanceof Error ? err.message : 'error'}`),
      );
    }, INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async checkDailyBudget(): Promise<{ estimated: number; budget: number; alerted: boolean } | null> {
    const budget = this.config.aiDailyEstimatedUsdBudget;
    if (budget == null) return null;

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const rows = await this.prisma.usageRecord.groupBy({
      by: ['model'],
      where: { createdAt: { gte: start } },
      _sum: { inputTokens: true, outputTokens: true },
    });

    let estimated = 0;
    let anyUnavailable = false;
    for (const r of rows) {
      const est = estimateUsd(r.model, r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0);
      if (est.estimatedUsd == null) anyUnavailable = true;
      else estimated += est.estimatedUsd;
    }

    if (estimated < budget) return { estimated, budget, alerted: false };

    const day = start.toISOString().slice(0, 10);
    const created = await this.notifications.notifyCeo({
      type: 'SYSTEM',
      title: 'AI estimated spend budget reached',
      body: `Estimated OpenAI cost today (~$${estimated.toFixed(4)}) exceeded the configured daily budget (~$${budget.toFixed(4)}). This is an ESTIMATE from token metadata, not an invoice.${anyUnavailable ? ' Some models have no rate table entry.' : ''}`,
      link: '/reports',
      dedupeKey: `ai-budget:${day}`,
    });
    if (created > 0) this.logger.warn(`AI estimated budget alert sent for ${day}`);
    return { estimated, budget, alerted: created > 0 };
  }
}
