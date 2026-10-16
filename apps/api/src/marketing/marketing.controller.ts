import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import {
  AttributeLeadDto,
  CreateCampaignAssetDto,
  CreateCampaignDto,
  CreateCompetitorReportDto,
  CreateContentDraftDto,
  CreateContentItemDto,
  CreateResearchProjectDto,
  FindingInputDto,
  GenerateMarketingReportDto,
  ImportCampaignMetricsDto,
  UpdateCampaignAssetDto,
  UpsertBrandProfileDto,
} from './marketing.dto';
import { MarketingService } from './marketing.service';

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('brand')
  brand() {
    return this.marketing.getBrandProfile();
  }

  @Roles(...WRITE_ROLES)
  @Patch('brand')
  updateBrand(@Body() dto: UpsertBrandProfileDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.upsertBrandProfile(dto, user, ctx);
  }

  @Get('research')
  listResearch() {
    return this.marketing.listResearchProjects();
  }

  @Get('research/:id')
  getResearch(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketing.getResearchProject(id);
  }

  @Roles(...WRITE_ROLES)
  @Post('research')
  createResearch(@Body() dto: CreateResearchProjectDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.createResearchProject(dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('research/:id/competitors')
  addCompetitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCompetitorReportDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.marketing.addCompetitorReport(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('research/:id/findings')
  addFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FindingInputDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.marketing.addProjectFinding(id, dto, user, ctx);
  }

  @Get('content')
  listContent(@Query('from') from?: string, @Query('to') to?: string) {
    return this.marketing.listContentCalendar({ from, to });
  }

  @Get('content/:id')
  getContent(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketing.getContentItem(id);
  }

  @Roles(...WRITE_ROLES)
  @Post('content')
  createContent(@Body() dto: CreateContentItemDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.createContentItem(dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('content/:id/drafts')
  createDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContentDraftDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.marketing.createContentDraft(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('content/:id/request-publish')
  @HttpCode(200)
  requestPublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.requestPublishContent(id, user, ctx);
  }

  @Get('campaigns')
  listCampaigns() {
    return this.marketing.listCampaigns();
  }

  @Get('campaigns/:id')
  getCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketing.getCampaign(id);
  }

  @Get('campaigns/:id/outcomes')
  outcomes(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketing.campaignOutcomes(id);
  }

  @Roles(...WRITE_ROLES)
  @Post('campaigns')
  createCampaign(@Body() dto: CreateCampaignDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.createCampaign(dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('campaigns/:id/assets')
  createAsset(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCampaignAssetDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.marketing.createCampaignAsset(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('assets/:assetId/versions')
  versionAsset(
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: UpdateCampaignAssetDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.marketing.updateCampaignAsset(assetId, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('campaigns/:id/request-launch')
  @HttpCode(200)
  requestLaunch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.requestLaunchCampaign(id, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('metrics/import')
  importMetrics(@Body() dto: ImportCampaignMetricsDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.importMetrics(dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('attribution')
  @HttpCode(200)
  attribute(@Body() dto: AttributeLeadDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.attributeLead(dto.leadId, dto.campaignId, user, ctx);
  }

  @Get('analytics')
  analytics() {
    return this.marketing.readAnalyticsSummary();
  }

  @Get('integrations')
  integrations() {
    return this.marketing.listAnalyticsIntegrations();
  }

  @Get('reports')
  listReports() {
    return this.marketing.listReports();
  }

  @Get('reports/:id')
  getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketing.getReport(id);
  }

  @Roles(...WRITE_ROLES)
  @Post('reports/generate')
  generateReport(@Body() dto: GenerateMarketingReportDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.marketing.generateReport(dto, user, ctx);
  }
}
