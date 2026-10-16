import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { FindingKind, MarketingReportPeriod } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCampaignAssetDto,
  CreateCampaignDto,
  CreateCompetitorReportDto,
  CreateContentDraftDto,
  CreateContentItemDto,
  CreateResearchProjectDto,
  GenerateMarketingReportDto,
  ImportCampaignMetricsDto,
  UpdateCampaignAssetDto,
  UpsertBrandProfileDto,
} from './marketing.dto';

const CONVERSION_DENOMINATORS: Record<string, string> = {
  click_through_rate: 'impressions',
  conversion_rate: 'clicks',
  lead_conversion_rate: 'attributed_leads_denominator',
  win_rate: 'qualified_opportunities',
};

@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Brand ──────────────────────────────────────────────────────────────

  async getBrandProfile() {
    return this.ensureBrand();
  }

  async upsertBrandProfile(dto: UpsertBrandProfileDto, user: AuthUser, ctx: RequestContext) {
    const existing = await this.ensureBrand();
    const updated = await this.prisma.brandProfile.update({
      where: { id: existing.id },
      data: {
        ...(dto.voiceGuidelines !== undefined && { voiceGuidelines: dto.voiceGuidelines }),
        ...(dto.servicesOffered !== undefined && { servicesOffered: dto.servicesOffered }),
        ...(dto.portfolioNotes !== undefined && { portfolioNotes: dto.portfolioNotes }),
        ...(dto.approvedClaims !== undefined && { approvedClaims: dto.approvedClaims }),
      },
    });
    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'brand.update',
      entityType: 'brand_profile',
      entityId: updated.id,
      ctx,
    });
    return updated;
  }

  // ─── Research ───────────────────────────────────────────────────────────

  async listResearchProjects() {
    return this.prisma.marketResearchProject.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { findings: true, competitorReports: true } },
      },
    });
  }

  async getResearchProject(id: string) {
    const p = await this.prisma.marketResearchProject.findUnique({
      where: { id },
      include: {
        findings: { orderBy: { researchedAt: 'desc' } },
        competitorReports: {
          orderBy: { researchedAt: 'desc' },
          include: {
            sources: true,
            findings: { orderBy: { researchedAt: 'desc' } },
          },
        },
      },
    });
    if (!p) throw new NotFoundException('Research project not found');
    return p;
  }

  async createResearchProject(dto: CreateResearchProjectDto, user: AuthUser, ctx: RequestContext) {
    const row = await this.prisma.marketResearchProject.create({
      data: {
        name: dto.name.trim(),
        country: dto.country.trim(),
        industry: dto.industry.trim(),
        serviceOffering: dto.serviceOffering.trim(),
        targetCustomerProfile: dto.targetCustomerProfile?.trim() || '',
        status: dto.status ?? 'PLANNED',
        notes: dto.notes?.trim() || '',
      },
    });
    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'research.project_create',
      entityType: 'market_research_project',
      entityId: row.id,
      data: { country: row.country, industry: row.industry },
      ctx,
    });
    return row;
  }

  async addCompetitorReport(projectId: string, dto: CreateCompetitorReportDto, user: AuthUser, ctx: RequestContext) {
    await this.getResearchProject(projectId);
    for (const f of dto.findings) this.assertFinding(f.kind, f.evidenceUrl);
    for (const url of dto.sourceUrls) {
      if (!isHttpUrl(url)) throw new BadRequestException(`Invalid source URL: ${url}`);
    }
    if (!dto.sourceUrls.length) throw new BadRequestException('At least one source URL is required for competitor research.');

    const researchedAt = dto.researchedAt ? new Date(dto.researchedAt) : new Date();
    const report = await this.prisma.$transaction(async (tx) => {
      const r = await tx.competitorReport.create({
        data: {
          projectId,
          competitorName: dto.competitorName.trim(),
          summary: dto.summary?.trim() || '',
          researchedAt,
          sources: {
            create: dto.sourceUrls.map((url) => ({
              url: url.trim(),
              title: '',
              fetchedAt: researchedAt,
            })),
          },
          findings: {
            create: dto.findings.map((f) => ({
              projectId,
              claim: f.claim.trim(),
              kind: f.kind,
              evidenceUrl: f.evidenceUrl?.trim() || null,
              sourceNote: f.sourceNote?.trim() || '',
              researchedAt: f.researchedAt ? new Date(f.researchedAt) : researchedAt,
            })),
          },
        },
        include: { sources: true, findings: true },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'research.competitor_report_create',
          entityType: 'competitor_report',
          entityId: r.id,
          data: { projectId, sources: dto.sourceUrls.length, findings: dto.findings.length },
          ctx,
        },
        tx,
      );
      return r;
    });
    return report;
  }

  async addProjectFinding(
    projectId: string,
    finding: { claim: string; kind: FindingKind; evidenceUrl?: string; sourceNote?: string; researchedAt?: string },
    user: AuthUser,
    ctx: RequestContext,
  ) {
    await this.getResearchProject(projectId);
    this.assertFinding(finding.kind, finding.evidenceUrl);
    const row = await this.prisma.researchFinding.create({
      data: {
        projectId,
        claim: finding.claim.trim(),
        kind: finding.kind,
        evidenceUrl: finding.evidenceUrl?.trim() || null,
        sourceNote: finding.sourceNote?.trim() || '',
        researchedAt: finding.researchedAt ? new Date(finding.researchedAt) : new Date(),
      },
    });
    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'research.finding_create',
      entityType: 'research_finding',
      entityId: row.id,
      data: { kind: row.kind, hasEvidence: Boolean(row.evidenceUrl) },
      ctx,
    });
    return row;
  }

  // ─── Content calendar & drafts ──────────────────────────────────────────

  async listContentCalendar(opts?: { from?: string; to?: string }) {
    const where: Prisma.ContentItemWhereInput = {};
    if (opts?.from || opts?.to) {
      where.scheduledFor = {
        ...(opts.from && { gte: new Date(opts.from) }),
        ...(opts.to && { lte: new Date(opts.to) }),
      };
    }
    return this.prisma.contentItem.findMany({
      where,
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1 },
        campaign: { select: { id: true, name: true } },
      },
    });
  }

  async createContentItem(dto: CreateContentItemDto, user: AuthUser, ctx: RequestContext) {
    if (dto.campaignId) await this.ensureCampaign(dto.campaignId);
    const row = await this.prisma.contentItem.create({
      data: {
        title: dto.title.trim(),
        channel: dto.channel,
        status: dto.status ?? (dto.scheduledFor ? 'SCHEDULED' : 'IDEA'),
        scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
        campaignId: dto.campaignId ?? null,
      },
    });
    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'content.item_create',
      entityType: 'content_item',
      entityId: row.id,
      data: { channel: row.channel },
      ctx,
    });
    return row;
  }

  async createContentDraft(itemId: string, dto: CreateContentDraftDto, user: AuthUser, ctx: RequestContext) {
    const item = await this.prisma.contentItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Content item not found');

    let body = dto.body.trim();
    let changeNote = dto.changeNote?.trim() || '';
    if (dto.useBrandProfile !== false) {
      const brand = await this.ensureBrand();
      const preface = [
        brand.voiceGuidelines ? `[Brand voice applied — guidelines on file]` : null,
        brand.servicesOffered.length ? `[Services: ${brand.servicesOffered.join(', ')}]` : null,
      ]
        .filter(Boolean)
        .join(' ');
      if (preface && !body.includes('[Brand voice')) {
        changeNote = changeNote || 'Draft uses configured brand profile (voice/services/approved claims only).';
      }
      // Never inject invented portfolio facts — only surface approvedClaims as a footer note for authors.
      if (brand.approvedClaims.length) {
        body = `${body}\n\n---\nApproved claims only (do not invent others):\n${brand.approvedClaims.map((c) => `• ${c}`).join('\n')}`;
      }
    }

    const nextVersion = item.currentVersion + 1;
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await tx.contentVersion.create({
        data: {
          contentItemId: itemId,
          version: nextVersion,
          title: dto.title.trim(),
          body,
          changeNote,
          status: 'DRAFT',
          createdByUserId: user.id,
        },
      });
      await tx.contentItem.update({
        where: { id: itemId },
        data: {
          title: dto.title.trim(),
          currentVersion: nextVersion,
          status: item.status === 'IDEA' || item.status === 'SCHEDULED' ? 'DRAFTING' : item.status,
        },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'content.draft_version',
          entityType: 'content_version',
          entityId: v.id,
          data: { contentItemId: itemId, version: nextVersion },
          ctx,
        },
        tx,
      );
      return v;
    });
    return version;
  }

  async getContentItem(id: string) {
    const item = await this.prisma.contentItem.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { version: 'desc' } },
        campaign: { select: { id: true, name: true, status: true } },
      },
    });
    if (!item) throw new NotFoundException('Content item not found');
    return item;
  }

  async requestPublishContent(
    contentItemId: string,
    user: AuthUser,
    ctx: RequestContext,
    opts?: { taskId?: string; requestedByAgentId?: string },
  ) {
    const item = await this.getContentItem(contentItemId);
    if (!item.versions.length) throw new BadRequestException('Create a draft version before requesting publish.');
    const latest = item.versions[0]!;

    const existing = await this.prisma.approval.findFirst({
      where: {
        actionType: 'PUBLISH_CONTENT',
        entityType: 'content_item',
        entityId: contentItemId,
        status: 'PENDING',
      },
    });
    if (existing) return { approvalId: existing.id, deduplicated: true };

    const approval = await this.prisma.$transaction(async (tx) => {
      const a = await tx.approval.create({
        data: {
          actionType: 'PUBLISH_CONTENT',
          status: 'PENDING',
          entityType: 'content_item',
          entityId: contentItemId,
          summary: `Publish “${latest.title}” (${item.channel})`,
          payload: {
            contentItemId,
            versionId: latest.id,
            version: latest.version,
            channel: item.channel,
          } as Prisma.InputJsonValue,
          taskId: opts?.taskId ?? null,
          requestedByAgentId: opts?.requestedByAgentId ?? null,
        },
      });
      await tx.contentItem.update({ where: { id: contentItemId }, data: { status: 'AWAITING_APPROVAL' } });
      await tx.contentVersion.update({ where: { id: latest.id }, data: { status: 'AWAITING_APPROVAL' } });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'content.request_publish',
          entityType: 'content_item',
          entityId: contentItemId,
          data: { approvalId: a.id },
          ctx,
        },
        tx,
      );
      return a;
    });

    await this.notifications.notifyCeo({
      type: 'APPROVAL_REQUIRED',
      title: 'Content publish awaiting approval',
      body: approval.summary,
      link: `/approvals/${approval.id}`,
      dedupeKey: `approval:${approval.id}`,
    });
    this.events.emit({ type: 'approval.updated', approvalId: approval.id, status: 'PENDING' });
    return { approvalId: approval.id, deduplicated: false };
  }

  /** Called after CEO approves PUBLISH_CONTENT — marks published; does not push to external networks. */
  async executePublishContent(approvalId: string, user: AuthUser, ctx: RequestContext) {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval || approval.actionType !== 'PUBLISH_CONTENT' || approval.status !== 'APPROVED') {
      throw new BadRequestException('Publish approval is not APPROVED.');
    }
    const payload = (approval.payload ?? {}) as { contentItemId?: string; versionId?: string };
    if (!payload.contentItemId) throw new BadRequestException('Approval payload missing contentItemId.');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.contentItem.update({
        where: { id: payload.contentItemId },
        data: { status: 'PUBLISHED', publishedAt: now },
      });
      if (payload.versionId) {
        await tx.contentVersion.update({ where: { id: payload.versionId }, data: { status: 'PUBLISHED' } });
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'content.published',
          entityType: 'content_item',
          entityId: payload.contentItemId,
          data: { approvalId, note: 'Marked published in HQ. External network posting is not automated.' },
          ctx,
        },
        tx,
      );
    });
    return { contentItemId: payload.contentItemId, status: 'PUBLISHED' as const };
  }

  // ─── Campaigns & assets ─────────────────────────────────────────────────

  async listCampaigns() {
    return this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { assets: true, attributedLeads: true, metricImports: true } },
      },
    });
  }

  async getCampaign(id: string) {
    const c = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        assets: { orderBy: { updatedAt: 'desc' }, include: { versions: { orderBy: { version: 'desc' }, take: 3 } } },
        metricImports: {
          orderBy: { importedAt: 'desc' },
          take: 10,
          include: { rows: true },
        },
        attributedLeads: { select: { id: true, name: true, stage: true, createdAt: true }, take: 50 },
        contentItems: { select: { id: true, title: true, channel: true, status: true } },
      },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    return { ...c, conversionMetrics: this.computeConversions(c.metricImports.flatMap((i) => i.rows)) };
  }

  async createCampaign(dto: CreateCampaignDto, user: AuthUser, ctx: RequestContext) {
    const row = await this.prisma.campaign.create({
      data: {
        name: dto.name.trim(),
        objective: dto.objective?.trim() || '',
        channel: dto.channel?.trim() || '',
        audience: dto.audience?.trim() || '',
        messaging: dto.messaging?.trim() || '',
        industries: dto.industries ?? [],
        countries: dto.countries ?? [],
        services: dto.services ?? [],
        budgetRecommendation: dto.budgetRecommendation != null ? new Prisma.Decimal(dto.budgetRecommendation) : null,
        budgetCurrency: (dto.budgetCurrency ?? 'USD').toUpperCase().slice(0, 8),
        isPaid: Boolean(dto.isPaid),
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        successMetrics: (dto.successMetrics ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        status: 'DRAFT',
      },
    });
    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: row.id,
      data: { isPaid: row.isPaid },
      ctx,
    });
    return row;
  }

  async createCampaignAsset(campaignId: string, dto: CreateCampaignAssetDto, user: AuthUser, ctx: RequestContext) {
    await this.ensureCampaign(campaignId);
    const asset = await this.prisma.$transaction(async (tx) => {
      const a = await tx.campaignAsset.create({
        data: {
          campaignId,
          type: dto.type,
          title: dto.title.trim(),
          content: dto.content.trim(),
          status: 'DRAFT',
          currentVersion: 1,
          scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
          versions: {
            create: {
              version: 1,
              title: dto.title.trim(),
              content: dto.content.trim(),
              changeNote: 'Initial version',
            },
          },
        },
        include: { versions: true },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'campaign.asset_create',
          entityType: 'campaign_asset',
          entityId: a.id,
          ctx,
        },
        tx,
      );
      return a;
    });
    return asset;
  }

  async updateCampaignAsset(assetId: string, dto: UpdateCampaignAssetDto, user: AuthUser, ctx: RequestContext) {
    const asset = await this.prisma.campaignAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.status === 'PUBLISHED') throw new BadRequestException('Published assets cannot be edited; create a new version via a new asset or clone.');

    const nextVersion = asset.currentVersion + 1;
    const title = dto.title?.trim() || asset.title;
    const content = dto.content?.trim() || asset.content;
    return this.prisma.$transaction(async (tx) => {
      await tx.campaignAssetVersion.create({
        data: {
          assetId,
          version: nextVersion,
          title,
          content,
          changeNote: dto.changeNote?.trim() || `Version ${nextVersion}`,
        },
      });
      const updated = await tx.campaignAsset.update({
        where: { id: assetId },
        data: { title, content, currentVersion: nextVersion, status: 'DRAFT' },
        include: { versions: { orderBy: { version: 'desc' } } },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'campaign.asset_version',
          entityType: 'campaign_asset',
          entityId: assetId,
          data: { version: nextVersion },
          ctx,
        },
        tx,
      );
      return updated;
    });
  }

  async requestLaunchCampaign(
    campaignId: string,
    user: AuthUser,
    ctx: RequestContext,
    opts?: { taskId?: string; requestedByAgentId?: string },
  ) {
    const campaign = await this.ensureCampaign(campaignId);
    if (!campaign.isPaid) {
      throw new BadRequestException('Only paid campaigns require launch approval. Mark isPaid=true or activate organic campaigns without spend.');
    }
    if (!['DRAFT', 'PROPOSED', 'APPROVED', 'PAUSED'].includes(campaign.status)) {
      throw new BadRequestException(`Cannot request launch from status ${campaign.status}.`);
    }

    const existing = await this.prisma.approval.findFirst({
      where: { actionType: 'LAUNCH_PAID_CAMPAIGN', entityType: 'campaign', entityId: campaignId, status: 'PENDING' },
    });
    if (existing) return { approvalId: existing.id, deduplicated: true };

    const approval = await this.prisma.$transaction(async (tx) => {
      const a = await tx.approval.create({
        data: {
          actionType: 'LAUNCH_PAID_CAMPAIGN',
          status: 'PENDING',
          entityType: 'campaign',
          entityId: campaignId,
          summary: `Launch paid campaign “${campaign.name}” (budget recommendation ${campaign.budgetRecommendation ?? 'none'} ${campaign.budgetCurrency})`,
          payload: {
            campaignId,
            isPaid: true,
            budgetRecommendation: campaign.budgetRecommendation?.toString() ?? null,
          } as Prisma.InputJsonValue,
          taskId: opts?.taskId ?? null,
          requestedByAgentId: opts?.requestedByAgentId ?? null,
        },
      });
      await tx.campaign.update({ where: { id: campaignId }, data: { status: 'AWAITING_APPROVAL' } });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'campaign.request_launch',
          entityType: 'campaign',
          entityId: campaignId,
          data: { approvalId: a.id },
          ctx,
        },
        tx,
      );
      return a;
    });

    await this.notifications.notifyCeo({
      type: 'APPROVAL_REQUIRED',
      title: 'Paid campaign launch awaiting approval',
      body: approval.summary,
      link: `/approvals/${approval.id}`,
      dedupeKey: `approval:${approval.id}`,
    });
    this.events.emit({ type: 'approval.updated', approvalId: approval.id, status: 'PENDING' });
    return { approvalId: approval.id, deduplicated: false };
  }

  async executeLaunchCampaign(approvalId: string, user: AuthUser, ctx: RequestContext) {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval || approval.actionType !== 'LAUNCH_PAID_CAMPAIGN' || approval.status !== 'APPROVED') {
      throw new BadRequestException('Launch approval is not APPROVED.');
    }
    const payload = (approval.payload ?? {}) as { campaignId?: string };
    if (!payload.campaignId) throw new BadRequestException('Approval payload missing campaignId.');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id: payload.campaignId },
        data: { status: 'ACTIVE', launchedAt: now },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'campaign.launched',
          entityType: 'campaign',
          entityId: payload.campaignId,
          data: {
            approvalId,
            note: 'Marked ACTIVE after CEO approval. Ad-network spend is not automated by HQ.',
          },
          ctx,
        },
        tx,
      );
    });
    return { campaignId: payload.campaignId, status: 'ACTIVE' as const };
  }

  // ─── Metrics & analytics ────────────────────────────────────────────────

  async listAnalyticsIntegrations() {
    await this.ensureDefaultIntegrations();
    return this.prisma.analyticsIntegration.findMany({ orderBy: { name: 'asc' } });
  }

  async importMetrics(dto: ImportCampaignMetricsDto, user: AuthUser, ctx: RequestContext) {
    if (dto.campaignId) await this.ensureCampaign(dto.campaignId);
    if (!dto.rows.length) throw new BadRequestException('At least one metric row is required.');

    for (const row of dto.rows) {
      if (isRateMetric(row.metricKey) && (row.denominator == null || !row.denominatorLabel)) {
        throw new BadRequestException(
          `Rate metric "${row.metricKey}" requires an explicit denominator and denominatorLabel (e.g. impressions).`,
        );
      }
    }

    const imp = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campaignMetricImport.create({
        data: {
          campaignId: dto.campaignId ?? null,
          sourceKind: 'MANUAL_IMPORT',
          sourceName: dto.sourceName.trim(),
          notes: dto.notes?.trim() || '',
          rows: {
            create: dto.rows.map((r) => ({
              metricKey: r.metricKey.trim(),
              value: new Prisma.Decimal(r.value),
              denominator: r.denominator != null ? new Prisma.Decimal(r.denominator) : null,
              denominatorLabel: r.denominatorLabel?.trim() || null,
              periodStart: r.periodStart ? new Date(r.periodStart) : null,
              periodEnd: r.periodEnd ? new Date(r.periodEnd) : null,
              notes: r.notes?.trim() || '',
            })),
          },
        },
        include: { rows: true },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'campaign.metrics_import',
          entityType: 'campaign_metric_import',
          entityId: created.id,
          data: { rows: dto.rows.length, campaignId: dto.campaignId ?? null },
          ctx,
        },
        tx,
      );
      return created;
    });
    return { import: imp, conversionMetrics: this.computeConversions(imp.rows) };
  }

  async attributeLead(leadId: string, campaignId: string | null | undefined, user: AuthUser, ctx: RequestContext) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (campaignId) await this.ensureCampaign(campaignId);
    await this.prisma.lead.update({ where: { id: leadId }, data: { attributedCampaignId: campaignId ?? null } });
    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'campaign.attribute_lead',
      entityType: 'lead',
      entityId: leadId,
      data: { campaignId: campaignId ?? null },
      ctx,
    });
    this.events.emit({ type: 'lead.updated', leadId });
    return this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { id: true, name: true, attributedCampaignId: true },
    });
  }

  async campaignOutcomes(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);
    const leads = campaign.attributedLeads;
    const won = leads.filter((l) => l.stage === 'WON').length;
    const qualified = leads.filter((l) => !['NEW', 'LOST', 'DO_NOT_CONTACT'].includes(l.stage)).length;
    return {
      campaignId,
      attributedLeads: leads.length,
      qualifiedAttributedLeads: qualified,
      wonAttributedLeads: won,
      /** Explicit denominators documented for UI */
      denominators: {
        attributedLeads: 'Count of leads with attributedCampaignId = this campaign (only when attribution was recorded).',
        qualifiedAttributedLeads: 'Attributed leads not in NEW / LOST / DO_NOT_CONTACT.',
        wonAttributedLeads: 'Attributed leads in WON (CEO-confirmed deals).',
        winRate: won === 0 && qualified === 0 ? null : { numerator: won, denominator: Math.max(qualified, 1), label: 'won ÷ qualified attributed leads' },
      },
      conversionMetrics: campaign.conversionMetrics,
      note: 'No engagement figures are invented. Metrics come only from imports or configured integrations.',
    };
  }

  // ─── Reports ────────────────────────────────────────────────────────────

  async listReports() {
    return this.prisma.marketingReport.findMany({ orderBy: { generatedAt: 'desc' }, take: 50 });
  }

  async getReport(id: string) {
    const r = await this.prisma.marketingReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Report not found');
    return r;
  }

  async generateReport(dto: GenerateMarketingReportDto, user: AuthUser, ctx: RequestContext) {
    const asOf = dto.asOf ? new Date(dto.asOf) : new Date();
    const { periodStart, periodEnd } = periodBounds(dto.period, asOf);

    const [campaignsCreated, assetsPublished, contentPublished, attributedLeads, metricImports, researchDone] =
      await Promise.all([
        this.prisma.campaign.count({ where: { createdAt: { gte: periodStart, lte: periodEnd } } }),
        this.prisma.campaignAsset.count({ where: { status: 'PUBLISHED', publishedAt: { gte: periodStart, lte: periodEnd } } }),
        this.prisma.contentItem.count({ where: { status: 'PUBLISHED', publishedAt: { gte: periodStart, lte: periodEnd } } }),
        this.prisma.lead.count({ where: { attributedCampaignId: { not: null }, createdAt: { gte: periodStart, lte: periodEnd } } }),
        this.prisma.campaignMetricImport.count({ where: { importedAt: { gte: periodStart, lte: periodEnd } } }),
        this.prisma.competitorReport.count({ where: { researchedAt: { gte: periodStart, lte: periodEnd } } }),
      ]);

    const mm = await this.prisma.agentDefinition.findUnique({ where: { key: 'marketing_manager' }, select: { id: true } });

    const snapshot = {
      period: dto.period,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      campaignsCreated,
      assetsPublished,
      contentPublished,
      attributedLeadsInPeriod: attributedLeads,
      metricImportsInPeriod: metricImports,
      competitorReportsInPeriod: researchDone,
      denominators: {
        campaignsCreated: 'Campaigns with createdAt in period.',
        assetsPublished: 'Campaign assets with status PUBLISHED and publishedAt in period.',
        contentPublished: 'Content items with status PUBLISHED and publishedAt in period.',
        attributedLeadsInPeriod: 'Leads created in period that have attributedCampaignId set (attribution recorded).',
        metricImportsInPeriod: 'Manual/integration metric import batches with importedAt in period.',
        competitorReportsInPeriod: 'Competitor reports with researchedAt in period.',
      },
      caveats: [
        'Verified findings require source URLs; suggestions and estimates are labeled separately.',
        'No competitor prices, engagement figures, or campaign results are invented.',
        'Publishing/launch marks records in HQ only after CEO approval; ad-network spend is not automated.',
        'Development after Won deals remains the CEO’s responsibility.',
      ],
    };

    const title = `${dto.period === 'DAILY' ? 'Daily' : 'Weekly'} Marketing Manager report — ${periodStart.toISOString().slice(0, 10)}`;
    const body = [
      title,
      '',
      `Period: ${periodStart.toISOString()} → ${periodEnd.toISOString()}`,
      '',
      `Campaigns created: ${campaignsCreated}`,
      `Assets published (HQ): ${assetsPublished}`,
      `Content items published (HQ): ${contentPublished}`,
      `Attributed leads created: ${attributedLeads}`,
      `Metric imports: ${metricImports}`,
      `Competitor reports: ${researchDone}`,
      '',
      'All counts use the denominators documented in metricsSnapshot.denominators.',
      'Estimates and model suggestions are not included in these totals.',
    ].join('\n');

    const report = await this.prisma.marketingReport.create({
      data: {
        period: dto.period,
        periodStart,
        periodEnd,
        title,
        body,
        metricsSnapshot: snapshot as Prisma.InputJsonValue,
        generatedByAgentId: mm?.id ?? null,
      },
    });

    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'marketing.report_generate',
      entityType: 'marketing_report',
      entityId: report.id,
      data: { period: dto.period },
      ctx,
    });

    await this.notifications.notifyCeo({
      type: 'REPORT_READY',
      title: title.slice(0, 200),
      body: `Campaigns ${campaignsCreated} · Published assets ${assetsPublished} · Attributed leads ${attributedLeads}`,
      link: `/marketing/reports/${report.id}`,
      dedupeKey: `marketing-report:${report.id}`,
    });

    return report;
  }

  /** Tool path: create campaign proposal from agent args. */
  async createCampaignFromTool(args: Record<string, unknown>) {
    const name = String(args.name ?? args.title ?? '').trim();
    if (name.length < 2) throw new BadRequestException('Campaign name is required.');
    return this.prisma.campaign.create({
      data: {
        name,
        objective: typeof args.objective === 'string' ? args.objective : '',
        channel: typeof args.channel === 'string' ? args.channel : '',
        audience: typeof args.audience === 'string' ? args.audience : '',
        messaging: typeof args.messaging === 'string' ? args.messaging : '',
        isPaid: Boolean(args.isPaid),
        budgetRecommendation:
          typeof args.budgetRecommendation === 'number' ? new Prisma.Decimal(args.budgetRecommendation) : null,
        status: 'PROPOSED',
        successMetrics: typeof args.successMetrics === 'object' && args.successMetrics ? (args.successMetrics as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  }

  /** Tool path: create content draft item + version. */
  async createContentDraftFromTool(args: Record<string, unknown>, userId: string) {
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? args.content ?? '').trim();
    const channelRaw = String(args.channel ?? 'LINKEDIN').toUpperCase();
    const allowed = ['LINKEDIN', 'WEBSITE_ARTICLE', 'CASE_STUDY', 'LANDING_PAGE', 'EMAIL_CAMPAIGN', 'OTHER'] as const;
    type Ch = (typeof allowed)[number];
    const channel: Ch = (allowed as readonly string[]).includes(channelRaw) ? (channelRaw as Ch) : 'OTHER';
    if (title.length < 2 || body.length < 10) throw new BadRequestException('title and body are required for content drafts.');

    const item = await this.prisma.contentItem.create({
      data: {
        title,
        channel,
        status: 'DRAFTING',
        currentVersion: 1,
        versions: {
          create: {
            version: 1,
            title,
            body,
            changeNote: 'Created via agent tool',
            status: 'DRAFT',
            createdByUserId: userId,
          },
        },
      },
      include: { versions: true },
    });
    return item;
  }

  async readAnalyticsSummary() {
    const integrations = await this.listAnalyticsIntegrations();
    const configured = integrations.filter((i) => i.isConfigured);
    const recentImports = await this.prisma.campaignMetricImport.findMany({
      orderBy: { importedAt: 'desc' },
      take: 20,
      include: { rows: true, campaign: { select: { id: true, name: true } } },
    });
    return {
      measured: configured.length > 0 || recentImports.length > 0,
      integrations: integrations.map((i) => ({
        key: i.key,
        name: i.name,
        isConfigured: i.isConfigured,
        credentialsEnv: i.credentialsEnv,
        lastSyncAt: i.lastSyncAt,
        notes: i.notes,
      })),
      recentImports: recentImports.map((imp) => ({
        id: imp.id,
        sourceKind: imp.sourceKind,
        sourceName: imp.sourceName,
        campaign: imp.campaign,
        importedAt: imp.importedAt,
        rows: imp.rows.length,
        conversionMetrics: this.computeConversions(imp.rows),
      })),
      note:
        configured.length === 0 && recentImports.length === 0
          ? 'No analytics integration is configured and no metric imports exist. Figures are not invented.'
          : 'Metrics reflect configured integrations and/or imported reports only.',
    };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private computeConversions(
    rows: Array<{ metricKey: string; value: Prisma.Decimal; denominator: Prisma.Decimal | null; denominatorLabel: string | null }>,
  ) {
    return rows
      .filter((r) => r.denominator != null && Number(r.denominator) > 0)
      .map((r) => {
        const num = Number(r.value);
        const den = Number(r.denominator);
        return {
          metricKey: r.metricKey,
          numerator: num,
          denominator: den,
          denominatorLabel: r.denominatorLabel ?? CONVERSION_DENOMINATORS[r.metricKey] ?? 'denominator',
          rate: den > 0 ? num / den : null,
          formula: `${r.metricKey} = value ÷ ${r.denominatorLabel ?? 'denominator'}`,
        };
      });
  }

  private assertFinding(kind: FindingKind, evidenceUrl?: string | null) {
    if (kind === 'VERIFIED' && (!evidenceUrl || !isHttpUrl(evidenceUrl))) {
      throw new BadRequestException('VERIFIED findings require a valid evidence URL. Use SUGGESTION or ESTIMATE if evidence is unavailable.');
    }
    if (evidenceUrl && !isHttpUrl(evidenceUrl)) {
      throw new BadRequestException('evidenceUrl must be a valid http(s) URL.');
    }
  }

  private async ensureBrand() {
    const existing = await this.prisma.brandProfile.findUnique({ where: { key: 'default' } });
    if (existing) return existing;
    return this.prisma.brandProfile.create({
      data: {
        key: 'default',
        voiceGuidelines: 'Clear, professional, specific. Never invent prices, results, or client logos.',
        servicesOffered: [],
        portfolioNotes: '',
        approvedClaims: [],
      },
    });
  }

  private async ensureCampaign(id: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  private async ensureDefaultIntegrations() {
    const defaults = [
      {
        key: 'manual_import',
        name: 'Manual metric import',
        isConfigured: true,
        notes: 'CSV/JSON imports entered by the CEO or Marketing Manager. Always available.',
      },
      {
        key: 'google_analytics',
        name: 'Google Analytics',
        isConfigured: false,
        credentialsEnv: 'GA_CREDENTIALS_JSON',
        notes: 'Not connected until credentials env is set and a sync adapter is implemented.',
      },
    ];
    for (const d of defaults) {
      await this.prisma.analyticsIntegration.upsert({
        where: { key: d.key },
        create: d,
        update: {},
      });
    }
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRateMetric(key: string): boolean {
  return /rate|ctr|cvr|ratio/i.test(key) || key in CONVERSION_DENOMINATORS;
}

function periodBounds(period: MarketingReportPeriod, asOf: Date): { periodStart: Date; periodEnd: Date } {
  const end = new Date(asOf);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  if (period === 'DAILY') {
    start.setUTCHours(0, 0, 0, 0);
  } else {
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);
  }
  return { periodStart: start, periodEnd: end };
}
