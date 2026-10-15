import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentsModule } from './agents/agents.module';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DepartmentsModule } from './departments/departments.module';
import { EventsModule } from './events/events.module';
import { PrismaModule } from './prisma/prisma.module';
import { SystemController } from './system/system.controller';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    AppConfigModule,
    // Default: 120 requests/minute per client. Login and password changes are stricter (see AuthController).
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }] }),
    PrismaModule,
    AuditModule,
    EventsModule,
    AuthModule,
    DepartmentsModule,
    AgentsModule,
    TasksModule,
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
