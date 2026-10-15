import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Prisma } from '../generated/prisma/client';
import { Roles } from '../common/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 50;
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(100) entityType?: string;
  @IsOptional() @IsString() @MaxLength(100) entityId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

@Controller('audit-logs')
@Roles('CEO', 'ADMIN')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() q: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action && { action: { startsWith: q.action } }),
      ...(q.entityType && { entityType: q.entityType }),
      ...(q.entityId && { entityId: q.entityId }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actorUser: { select: { id: true, name: true, email: true } }, actorAgent: { select: { id: true, name: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
