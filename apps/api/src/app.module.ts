import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentsModule } from './agents/agents.module';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { ConnectorsModule } from './connectors/connectors.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DepartmentsModule } from './departments/departments.module';
import { EmailModule } from './email/email.module';
import { EventsModule } from './events/events.module';
import { LeadsModule } from './leads/leads.module';
import { MarketingModule } from './marketing/marketing.module';
import { MessagesModule } from './messages/messages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { OutreachModule } from './outreach/outreach.module';
import { PrismaModule } from './prisma/prisma.module';
import { SourcesModule } from './sources/sources.module';
import { SystemController } from './system/system.controller';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [{ name: 'default', ttl: config.throttleTtlMs, limit: config.throttleLimit }],
      }),
    }),
    PrismaModule,
    AuditModule,
    EventsModule,
    AuthModule,
    AiModule,
    EmailModule,
    NotificationsModule,
    MessagesModule,
    ConnectorsModule,
    DepartmentsModule,
    AgentsModule,
    TasksModule,
    LeadsModule,
    SourcesModule,
    OutreachModule,
    MarketingModule,
    OrchestrationModule,
    DashboardModule,
  ],
  controllers: [SystemController],
  providers: [
    // Order matters: rate-limit first, then authenticate/authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
})
export class AppModule {}
