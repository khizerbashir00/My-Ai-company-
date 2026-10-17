import { Module } from '@nestjs/common';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { SocialModule } from '../social/social.module';
import { SourcesModule } from '../sources/sources.module';
import { TasksModule } from '../tasks/tasks.module';
import { AiTaskWorkerService } from './ai-task-worker.service';
import { ControlController } from './control.controller';
import { ControlService } from './control.service';
import { RecoveryService } from './recovery.service';

@Module({
  imports: [OrchestrationModule, SourcesModule, TasksModule, SocialModule],
  controllers: [ControlController],
  providers: [ControlService, AiTaskWorkerService, RecoveryService],
  exports: [AiTaskWorkerService, RecoveryService],
})
export class ControlModule {}
