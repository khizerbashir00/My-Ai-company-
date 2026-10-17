import { Module, OnModuleInit } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { TasksModule } from '../tasks/tasks.module';
import { ScanQueueService } from './scan-queue.service';
import { ScanSchedulerService } from './scan-scheduler.service';
import { ScanService } from './scan.service';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [LeadsModule, TasksModule],
  controllers: [SourcesController],
  providers: [ScanService, ScanQueueService, ScanSchedulerService, SourcesService],
  exports: [SourcesService, ScanService, ScanQueueService, ScanSchedulerService],
})
export class SourcesModule implements OnModuleInit {
  constructor(private readonly sources: SourcesService) {}

  async onModuleInit(): Promise<void> {
    await this.sources.ensureDefaultConnections();
  }
}
