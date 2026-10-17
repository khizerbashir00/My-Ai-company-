import { Module } from '@nestjs/common';
import { BudgetAlertService } from './budget-alert.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, BudgetAlertService],
  exports: [DashboardService, BudgetAlertService],
})
export class DashboardModule {}
