import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutreachService } from './outreach.service';

const TICK_MS = 60_000;

@Injectable()
export class FollowUpScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FollowUpScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly outreach: OutreachService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.outreach.processDueFollowUps().catch((err) =>
        this.logger.warn(`Follow-up tick failed: ${err instanceof Error ? err.message : 'error'}`),
      );
    }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
