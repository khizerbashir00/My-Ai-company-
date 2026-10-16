import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { ListScanRunsQueryDto, ManualImportLeadDto, UpdateConnectionDto } from './sources.dto';
import { SourcesService } from './sources.service';

@Controller('sources')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  list() {
    return this.sources.list();
  }

  @Get('scans')
  listScans(@Query() q: ListScanRunsQueryDto) {
    return this.sources.listScanRuns(q);
  }

  @Get('scans/:id')
  getScan(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.getScanRun(id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.get(id);
  }

  @Roles(...WRITE_ROLES)
  @Patch('connections/:connectionId')
  updateConnection(@Param('connectionId', ParseUUIDPipe) connectionId: string, @Body() dto: UpdateConnectionDto) {
    return this.sources.updateConnection(connectionId, dto);
  }

  @Roles(...WRITE_ROLES)
  @Post('connections/:connectionId/scan')
  @HttpCode(202)
  startScan(@Param('connectionId', ParseUUIDPipe) connectionId: string) {
    return this.sources.startScan(connectionId);
  }

  @Roles(...WRITE_ROLES)
  @Post('manual-import')
  manualImport(@Body() dto: ManualImportLeadDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.sources.manualImport(dto, user, ctx);
  }
}
