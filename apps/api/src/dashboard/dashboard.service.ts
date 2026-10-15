import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { LeadStage } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface DashboardFilters {
  from?: Date;
  to?: Date;
  sourceId?: string;
  departmentId?: string;
}

const INTERESTED_STAGES: LeadStage[] = ['INTERESTED', 'DEMO_REQUESTED', 'DEMO_COMPLETED', 'NEGOTIATION'];
const DEMO_STAGES: LeadStage[] = ['DEMO_REQUESTED', 'DEMO_COMPLETED', 'NEGOTIATION', 'WON'];

/** Every number is a database count — nothing is estimated or hardcoded. */
export const METRIC_DEFINITIONS = {
  dateRange: 'Lead metrics use leads discovered (created) in the range; event metrics use when the event happened.',
  leadsTotal: 'Leads discovered in the range.',
  leadsQualified: 'Leads in the range whose latest score is labelled High or Medium intent.',
  leadsHighIntent: 'Leads in the range whose latest score is labelled High intent.',
  outreachDrafts: 'Outreach messages created in the range that are still drafts or awaiting approval.',
  messagesSent: 'Outreach messages actually sent in the range.',
  repliesReceived: 'Distinct leads with at least one recorded reply in the range.',
  interestedProspects: 'Leads in the range currently at Interested, Demo Requested, Demo Completed or Negotiation.',
  demoRequests: 'Leads in the range currently at Demo Requested or a later stage (Demo Completed, Negotiation, Won).',
  meetingsScheduled: 'Leads with a demo/meeting date that falls in the range.',
  dealsWon: 'Deals the CEO confirmed in the range (development projects created).',
  dealsLost: 'Leads marked Lost in the range.',
  revenue: 'Sum of deal values the CEO confirmed in the range, per currency.',
  taskCompletionRate: 'Completed tasks ÷ finished tasks (completed + failed + cancelled) created in the range. Null when none finished.',
  pendingApprovals: 'Approval requests waiting for a decision right now (not date-filtered).',
} as const;

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

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
      campaignGroups,
      assetsPublished,
      recentTasks,
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
    ]);

    const stageCount = (stages: LeadStage[]) => stageGroups.filter((g) => stages.includes(g.stage)).reduce((n, g) => n + g._count._all, 0);
    const taskCount = (s: string) => taskStatusGroups.find((g) => g.status === s)?._count._all ?? 0;
    const finished = taskCount('COMPLETED') + taskCount('FAILED') + taskCount('CANCELLED');

    return {
      filters: { from: f.from?.toISOString() ?? null, to: f.to?.toISOString() ?? null, sourceId: f.sourceId ?? null, departmentId: f.departmentId ?? null },
      generatedAt: new Date().toISOString(),
      sales: {
        leadsTotal,
        leadsQualified,
        leadsHighIntent,
        outreachDrafts,
        messagesSent,
        repliesReceived: replyLeads.length,
        interestedProspects: stageCount(INTERESTED_STAGES),
        demoRequests: stageCount(DEMO_STAGES),
        meetingsScheduled,
        dealsWon,
        dealsLost,
        revenue: revenueGroups.map((r) => ({ currency: r.currency, amount: (r._sum.dealValue ?? new Prisma.Decimal(0)).toFixed(2), deals: r._count._all })),
        pipeline: Object.values(LeadStage).map((stage) => ({ stage, count: stageCount([stage]) })),
      },
      marketing: {
        campaignsByStatus: campaignGroups.map((g) => ({ status: g.status, count: g._count._all })),
        assetsPublished,
        // Reach/engagement/visits come from analytics integrations (Phase 5); until then nothing is reported.
        performance: { measured: false, note: 'No marketing analytics integration is connected yet.' },
      },
      tasks: {
        total: taskStatusGroups.reduce((n, g) => n + g._count._all, 0),
        byStatus: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'].map((status) => ({ status, count: taskCount(status) })),
        completionRate: finished ? taskCount('COMPLETED') / finished : null,
        failed: taskCount('FAILED'),
        pendingApprovals,
        recent: recentTasks,
      },
      definitions: METRIC_DEFINITIONS,
    };
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
