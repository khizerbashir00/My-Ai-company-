import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { DashboardService } from './dashboard.service';

class DashboardQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('metrics')
  metrics(@Query() q: DashboardQueryDto) {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    if (from && to && from > to) throw new BadRequestException('"from" must be before "to"');
    return this.dashboard.metrics({ from, to, sourceId: q.sourceId, departmentId: q.departmentId });
  }
}
