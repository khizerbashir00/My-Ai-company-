import { Module, forwardRef } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ApprovalsController } from '../approvals/approvals.controller';
import { ApprovalsService } from '../approvals/approvals.service';
import { MarketingModule } from '../marketing/marketing.module';
import { FollowUpScheduler } from './follow-up.scheduler';
import { OutreachController } from './outreach.controller';
import { OutreachService } from './outreach.service';

@Module({
  imports: [AiModule, forwardRef(() => MarketingModule)],
  controllers: [OutreachController, ApprovalsController],
  providers: [OutreachService, ApprovalsService, FollowUpScheduler],
  exports: [OutreachService, ApprovalsService],
})
export class OutreachModule {}
