import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MarketingReportPeriod } from '../generated/prisma/client';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { DashboardService } from './dashboard.service';

class DashboardQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
}

class GenerateCeoReportDto {
  @IsEnum(MarketingReportPeriod) period!: MarketingReportPeriod;
  @IsOptional() @IsDateString() asOf?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
}

class ReportListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
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

  @Get('reports')
  listReports(@Query() q: ReportListQueryDto) {
    return this.dashboard.listCeoReports({ page: q.page, pageSize: q.pageSize });
  }

  @Get('reports/:id')
  getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.dashboard.getCeoReport(id);
  }

  @Roles(...WRITE_ROLES)
  @Post('reports/generate')
  generate(@Body() dto: GenerateCeoReportDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.dashboard.generateCeoReport(dto.period, user, ctx, {
      asOf: dto.asOf,
      sourceId: dto.sourceId,
      departmentId: dto.departmentId,
    });
  }
}
