import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WorkflowStateService } from '../control/control-core';
import { OutreachService } from './outreach.service';

const TICK_MS = 60_000;

@Injectable()
export class FollowUpScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FollowUpScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly outreach: OutreachService,
    private readonly workflows: WorkflowStateService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** One pass over due follow-ups. Skipped while the Control Center has this workflow stopped. */
  async tick(): Promise<number> {
    if (!this.workflows.isEnabled('outreach-follow-ups')) return 0;
    try {
      const n = await this.outreach.processDueFollowUps();
      this.workflows.recordTick('outreach-follow-ups', { ok: true, message: `Processed ${n} due follow-up(s).` });
      return n;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error';
      this.workflows.recordTick('outreach-follow-ups', { ok: false, error: msg });
      this.logger.warn(`Follow-up tick failed: ${msg}`);
      return 0;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
