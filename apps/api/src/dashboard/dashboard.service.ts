import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { MarketingReportPeriod } from '../generated/prisma/client';
import { LeadStage } from '../generated/prisma/enums';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { estimateUsd } from './ai-usage';

export interface DashboardFilters {
  from?: Date;
  to?: Date;
  sourceId?: string;
  departmentId?: string;
}

const INTERESTED_STAGES: LeadStage[] = ['INTERESTED', 'DEMO_REQUESTED', 'DEMO_COMPLETED', 'NEGOTIATION'];
const DEMO_STAGES: LeadStage[] = ['DEMO_REQUESTED', 'DEMO_COMPLETED', 'NEGOTIATION', 'WON'];

/** Every number is a database count — nothing is estimated or hardcoded (except AI cost ESTIMATEs, labeled). */
export const METRIC_DEFINITIONS = {
  dateRange: 'Lead metrics use leads discovered (created) in the range; event metrics use when the event happened.',
  leadsTotal: 'Leads discovered in the range.',
  leadsQualified: 'Leads in the range whose latest score is labelled High or Medium intent.',
  leadsHighIntent: 'Leads in the range whose latest score is labelled High intent.',
  outreachDrafts: 'Outreach messages created in the range that are still drafts or awaiting approval.',
  draftsAwaitingApproval:
    'Pending CEO approvals for send / publish / paid launch right now (not date-filtered). Denominator: Approval rows with status PENDING and actionType in SEND_EXTERNAL_MESSAGE, PUBLISH_CONTENT, LAUNCH_PAID_CAMPAIGN.',
  messagesSent: 'Outreach messages actually sent in the range (filtered by sentAt).',
  repliesReceived: 'Distinct leads with at least one recorded reply in the range.',
  interestedProspects: 'Leads in the range currently at Interested, Demo Requested, Demo Completed or Negotiation.',
  demoRequests: 'Leads in the range currently at Demo Requested or a later stage (Demo Completed, Negotiation, Won).',
  negotiations: 'Leads in the range currently at Negotiation.',
  meetingsScheduled: 'Leads with a demo/meeting date that falls in the range.',
  dealsWon: 'Deals the CEO confirmed in the range (development projects created).',
  dealsLost: 'Leads marked Lost in the range.',
  revenue: 'Sum of deal values the CEO confirmed in the range, per currency. Only manually confirmed deals.',
  taskCompletionRate: 'Completed tasks ÷ finished tasks (completed + failed + cancelled) created in the range. Null when none finished.',
  pendingApprovals: 'All approval requests waiting for a decision right now (not date-filtered).',
  aiUsageTokens: 'Sum of input/output/total tokens from UsageRecord rows created in the range (provider metadata).',
  aiUsageEstimatedCost:
    'ESTIMATE only: USD derived from recorded tokens × publicly listed model rates. Not OpenAI invoices or actual billing. Null when the model has no rate table entry.',
  marketingPerformance: 'Reach/engagement only when a non-manual analytics integration is configured or metric reports have been imported. Never invented.',
} as const;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async marketingPerformance() {
    const configured = await this.prisma.analyticsIntegration.count({ where: { isConfigured: true, key: { not: 'manual_import' } } });
    const imports = await this.prisma.campaignMetricImport.count();
    if (configured === 0 && imports === 0) {
      return {
        measured: false,
        note: 'No analytics integration is connected and no metric reports have been imported. Figures are not invented.',
        unavailable: ['reach', 'engagement', 'click_through_rate', 'cost_per_lead', 'ad_spend_actual'],
      };
    }
    return {
      measured: true,
      note:
        configured > 0
          ? 'Metrics reflect configured integrations and/or imported reports only.'
          : 'Metrics reflect imported reports only (no live analytics integration configured).',
      unavailable: configured > 0 ? [] : ['live_ad_network_spend', 'realtime_engagement'],
    };
  }

  async metrics(f: DashboardFilters) {
    const created = range(f, 'createdAt');
    const leadWhere: Prisma.LeadWhereInput = { ...created, ...(f.sourceId && { sources: { some: { sourceId: f.sourceId } } }) };
    const leadRel: Prisma.LeadWhereInput | undefined = f.sourceId ? { sources: { some: { sourceId: f.sourceId } } } : undefined;
    const taskWhere: Prisma.TaskWhereInput = { ...created, ...(f.departmentId && { departmentId: f.departmentId }) };

    const p = this.prisma;
    const [
      leadsTotal,
      leadsQualified,
      leadsHighIntent,
      stageGroups,
      outreachDrafts,
      messagesSent,
      replyLeads,
      meetingsScheduled,
      dealsWon,
      dealsLost,
      revenueGroups,
      taskStatusGroups,
      pendingApprovals,
      draftsAwaitingApproval,
      campaignGroups,
      assetsPublished,
      recentTasks,
      usageRows,
    ] = await Promise.all([
      p.lead.count({ where: leadWhere }),
      p.lead.count({ where: { ...leadWhere, intentLabel: { in: ['HIGH', 'MEDIUM'] } } }),
      p.lead.count({ where: { ...leadWhere, intentLabel: 'HIGH' } }),
      p.lead.groupBy({ by: ['stage'], where: leadWhere, _count: { _all: true } }),
      p.outreachMessage.count({ where: { ...created, status: { in: ['DRAFT', 'AWAITING_APPROVAL'] }, ...(leadRel && { lead: leadRel }) } }),
      p.outreachMessage.count({ where: { status: 'SENT', ...range(f, 'sentAt'), ...(leadRel && { lead: leadRel }) } }),
      p.outreachEvent.findMany({
        where: { type: 'REPLY_RECEIVED', ...range(f, 'occurredAt'), ...(leadRel && { lead: leadRel }) },
        distinct: ['leadId'],
        select: { leadId: true },
      }),
      p.lead.count({ where: { demoScheduledAt: rangeValue(f) ?? { not: null }, ...leadRel } }),
      p.project.count({ where: { ...range(f, 'confirmedAt'), ...(leadRel && { lead: leadRel }) } }),
      p.lead.count({ where: { stage: 'LOST', lostAt: rangeValue(f) ?? { not: null }, ...leadRel } }),
      p.project.groupBy({ by: ['currency'], where: { ...range(f, 'confirmedAt'), ...(leadRel && { lead: leadRel }) }, _sum: { dealValue: true }, _count: { _all: true } }),
      p.task.groupBy({ by: ['status'], where: taskWhere, _count: { _all: true } }),
      p.approval.count({ where: { status: 'PENDING' } }),
      p.approval.count({
        where: {
          status: 'PENDING',
          actionType: { in: ['SEND_EXTERNAL_MESSAGE', 'PUBLISH_CONTENT', 'LAUNCH_PAID_CAMPAIGN'] },
        },
      }),
      p.campaign.groupBy({ by: ['status'], where: created, _count: { _all: true } }),
      p.campaignAsset.count({ where: { status: 'PUBLISHED', ...range(f, 'publishedAt') } }),
      p.task.findMany({
        where: taskWhere,
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          kind: true,
          updatedAt: true,
          assignedAgent: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
        },
      }),
      p.usageRecord.groupBy({
        by: ['provider', 'model'],
        where: range(f, 'createdAt'),
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
        _count: { _all: true },
      }),
    ]);

    const stageCount = (stages: LeadStage[]) => stageGroups.filter((g) => stages.includes(g.stage)).reduce((n, g) => n + g._count._all, 0);
    const taskCount = (s: string) => taskStatusGroups.find((g) => g.status === s)?._count._all ?? 0;
    const finished = taskCount('COMPLETED') + taskCount('FAILED') + taskCount('CANCELLED');

    const byModel = usageRows.map((r) => {
      const inputTokens = r._sum.inputTokens ?? 0;
      const outputTokens = r._sum.outputTokens ?? 0;
      const totalTokens = r._sum.totalTokens ?? 0;
      const est = estimateUsd(r.model, inputTokens, outputTokens);
      return {
        provider: r.provider,
        model: r.model,
        calls: r._count._all,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedUsd: est.estimatedUsd,
        costKind: est.kind,
        rateSource: est.rateSource,
      };
    });
    const totalInput = byModel.reduce((n, m) => n + m.inputTokens, 0);
    const totalOutput = byModel.reduce((n, m) => n + m.outputTokens, 0);
    const totalTokens = byModel.reduce((n, m) => n + m.totalTokens, 0);
    const estimatedParts = byModel.filter((m) => m.estimatedUsd != null).map((m) => m.estimatedUsd!);
    const estimatedUsdTotal = estimatedParts.length ? estimatedParts.reduce((a, b) => a + b, 0) : null;
    const unknownModels = byModel.filter((m) => m.costKind === 'UNAVAILABLE').map((m) => m.model);

    return {
      filters: { from: f.from?.toISOString() ?? null, to: f.to?.toISOString() ?? null, sourceId: f.sourceId ?? null, departmentId: f.departmentId ?? null },
      generatedAt: new Date().toISOString(),
      sales: {
        leadsTotal,
        leadsQualified,
        leadsHighIntent,
        outreachDrafts,
        draftsAwaitingApproval,
        messagesSent,
        repliesReceived: replyLeads.length,
        interestedProspects: stageCount(INTERESTED_STAGES),
        demoRequests: stageCount(DEMO_STAGES),
        negotiations: stageCount(['NEGOTIATION']),
        meetingsScheduled,
        dealsWon,
        dealsLost,
        revenue: revenueGroups.map((r) => ({ currency: r.currency, amount: (r._sum.dealValue ?? new Prisma.Decimal(0)).toFixed(2), deals: r._count._all })),
        pipeline: Object.values(LeadStage).map((stage) => ({ stage, count: stageCount([stage]) })),
      },
      marketing: {
        campaignsByStatus: campaignGroups.map((g) => ({ status: g.status, count: g._count._all })),
        assetsPublished,
        attributedLeads: await p.lead.count({ where: { ...leadWhere, attributedCampaignId: { not: null } } }),
        metricImports: await p.campaignMetricImport.count({ where: range(f, 'importedAt') }),
        performance: await this.marketingPerformance(),
      },
      tasks: {
        total: taskStatusGroups.reduce((n, g) => n + g._count._all, 0),
        byStatus: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'].map((status) => ({ status, count: taskCount(status) })),
        completionRate: finished ? taskCount('COMPLETED') / finished : null,
        failed: taskCount('FAILED'),
        pendingApprovals,
        recent: recentTasks,
      },
      aiUsage: {
        measured: byModel.length > 0,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalTokens,
        calls: byModel.reduce((n, m) => n + m.calls, 0),
        byModel,
        estimatedUsdTotal,
        costKind: estimatedUsdTotal == null ? ('UNAVAILABLE' as const) : ('ESTIMATE' as const),
        note:
          byModel.length === 0
            ? 'No AI usage records in this range. Costs are not invented.'
            : unknownModels.length
              ? `Token counts are from provider metadata. USD totals are ESTIMATES where rates are known; unavailable for: ${unknownModels.join(', ')}. Not actual billing.`
              : 'Token counts are from provider metadata. USD totals are ESTIMATES from published list prices — not actual provider invoices.',
      },
      definitions: METRIC_DEFINITIONS,
    };
  }

  async listCeoReports(opts?: { page?: number; pageSize?: number }) {
    const page = opts?.page ?? 1;
    const pageSize = Math.min(opts?.pageSize ?? 25, 100);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.ceoReport.count(),
      this.prisma.ceoReport.findMany({
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          period: true,
          periodStart: true,
          periodEnd: true,
          title: true,
          generatedAt: true,
        },
      }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async getCeoReport(id: string) {
    const r = await this.prisma.ceoReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Report not found');
    return r;
  }

  async generateCeoReport(
    period: MarketingReportPeriod,
    user: AuthUser,
    ctx: RequestContext,
    opts?: { asOf?: string; sourceId?: string; departmentId?: string },
  ) {
    const asOf = opts?.asOf ? new Date(opts.asOf) : new Date();
    const { periodStart, periodEnd } = periodBounds(period, asOf);
    const snapshot = await this.metrics({
      from: periodStart,
      to: periodEnd,
      sourceId: opts?.sourceId,
      departmentId: opts?.departmentId,
    });

    const title = `${period === 'DAILY' ? 'Daily' : 'Weekly'} CEO report — ${periodStart.toISOString().slice(0, 10)}`;
    const body = [
      title,
      '',
      `Period: ${periodStart.toISOString()} → ${periodEnd.toISOString()}`,
      '',
      `Leads discovered: ${snapshot.sales.leadsTotal}`,
      `Qualified: ${snapshot.sales.leadsQualified} · High intent: ${snapshot.sales.leadsHighIntent}`,
      `Messages sent: ${snapshot.sales.messagesSent} · Replies: ${snapshot.sales.repliesReceived}`,
      `Demo requests: ${snapshot.sales.demoRequests} · Negotiations: ${snapshot.sales.negotiations}`,
      `Won: ${snapshot.sales.dealsWon} · Lost: ${snapshot.sales.dealsLost}`,
      `Revenue: ${snapshot.sales.revenue.map((r) => `${r.amount} ${r.currency}`).join(', ') || '—'}`,
      `Tasks completed: ${snapshot.tasks.byStatus.find((s) => s.status === 'COMPLETED')?.count ?? 0} · Failed: ${snapshot.tasks.failed} · Awaiting approval: ${snapshot.tasks.byStatus.find((s) => s.status === 'AWAITING_APPROVAL')?.count ?? 0}`,
      `Drafts awaiting approval: ${snapshot.sales.draftsAwaitingApproval}`,
      `AI tokens (recorded): ${snapshot.aiUsage.totalTokens} · Estimated USD: ${snapshot.aiUsage.estimatedUsdTotal ?? 'unavailable'} (${snapshot.aiUsage.costKind})`,
      `Marketing campaigns: ${snapshot.marketing.campaignsByStatus.reduce((n, c) => n + c.count, 0)} · Attributed leads: ${snapshot.marketing.attributedLeads}`,
      '',
      snapshot.marketing.performance.note,
      snapshot.aiUsage.note,
      '',
      'All counts use the denominators in metricsSnapshot.definitions. AI USD figures are ESTIMATES, not invoices.',
      'Demos, deal closing, and software development after Won remain the CEO’s responsibility.',
    ].join('\n');

    const report = await this.prisma.ceoReport.create({
      data: {
        period,
        periodStart,
        periodEnd,
        title,
        body,
        metricsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        generatedByUserId: user.id,
      },
    });

    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'ceo.report_generate',
      entityType: 'ceo_report',
      entityId: report.id,
      data: { period },
      ctx,
    });

    await this.notifications.notifyCeo({
      type: 'REPORT_READY',
      title: title.slice(0, 200),
      body: `Leads ${snapshot.sales.leadsTotal} · Won ${snapshot.sales.dealsWon} · Tokens ${snapshot.aiUsage.totalTokens}`,
      link: `/reports/${report.id}`,
      dedupeKey: `ceo-report:${report.id}`,
    });

    return report;
  }
}

function rangeValue(f: DashboardFilters): Prisma.DateTimeFilter | undefined {
  if (!f.from && !f.to) return undefined;
  return { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) };
}

function range<K extends string>(f: DashboardFilters, field: K): Partial<Record<K, Prisma.DateTimeFilter>> {
  const value = rangeValue(f);
  return value ? ({ [field]: value } as Record<K, Prisma.DateTimeFilter>) : {};
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
