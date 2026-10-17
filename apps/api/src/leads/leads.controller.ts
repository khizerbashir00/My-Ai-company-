import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import {
  CreateLeadDto,
  CreateOutreachDraftDto,
  CsvImportConfirmDto,
  CsvImportPreviewDto,
  GenerateOutreachDto,
  ListLeadsQueryDto,
  ScoreLeadDto,
  TransitionLeadDto,
  UpdateLeadDto,
  UpdateOutreachDraftDto,
} from './leads.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get('meta/rubric')
  rubric() {
    return this.leads.rubric();
  }

  @Get('meta/stages')
  stages() {
    return { stages: this.leads.stages() };
  }

  @Get('pipeline')
  pipeline(@Query() q: ListLeadsQueryDto) {
    return this.leads.pipeline(q);
  }

  @Get('export')
  async exportCsv(@Query() q: ListLeadsQueryDto, @Res() res: Response) {
    const csv = await this.leads.exportCsv(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  }

  @Get()
  list(@Query() q: ListLeadsQueryDto) {
    return this.leads.list(q);
  }

  @Roles(...WRITE_ROLES)
  @Post('import/preview')
  @HttpCode(200)
  previewImport(@Body() dto: CsvImportPreviewDto) {
    return this.leads.previewImport(dto.csv, dto.sourceKey);
  }

  @Roles(...WRITE_ROLES)
  @Post('import/confirm')
  @HttpCode(200)
  confirmImport(@Body() dto: CsvImportConfirmDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.leads.confirmImport(dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post()
  create(@Body() dto: CreateLeadDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.leads.create(dto, user, ctx);
  }

  @Get(':id/briefing')
  briefing(@Param('id', ParseUUIDPipe) id: string) {
    return this.leads.briefing(id);
  }

  @Get(':id/outreach')
  listDrafts(@Param('id', ParseUUIDPipe) id: string) {
    return this.leads.listDrafts(id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(id);
  }

  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.leads.update(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/transition')
  @HttpCode(200)
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionLeadDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.leads.transition(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/score')
  @HttpCode(200)
  score(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScoreLeadDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.leads.score(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/outreach/generate')
  generateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateOutreachDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.leads.generateDraft(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/outreach')
  createDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateOutreachDraftDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.leads.createDraft(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Patch(':id/outreach/:messageId')
  updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: UpdateOutreachDraftDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.leads.updateDraft(id, messageId, dto, user, ctx);
  }
}
