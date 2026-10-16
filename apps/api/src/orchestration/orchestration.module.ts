import { Module } from '@nestjs/common';
import { MarketingModule } from '../marketing/marketing.module';
import { OutreachModule } from '../outreach/outreach.module';
import { SourcesModule } from '../sources/sources.module';
import { TasksModule } from '../tasks/tasks.module';
import { GmPlannerService } from './gm-planner.service';
import { OrchestrationController } from './orchestration.controller';
import { RunsService } from './runs.service';
import { TaskRunnerService } from './task-runner.service';
import { ToolExecutorService } from './tool-executor.service';

@Module({
  imports: [TasksModule, SourcesModule, OutreachModule, MarketingModule],
  controllers: [OrchestrationController],
  providers: [RunsService, ToolExecutorService, GmPlannerService, TaskRunnerService],
  exports: [TaskRunnerService, ToolExecutorService],
})
export class OrchestrationModule {}
