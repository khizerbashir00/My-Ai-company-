import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { LeadStage, OutreachChannel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { AiService } from '../ai/ai.service';
import { AiCredentialsError, AiOutputValidationError, AiProviderError } from '../ai/ai.errors';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { Page, toPage } from '../common/pagination';
import { MANUAL_IMPORT_SOURCE_KEY } from '../database/seed';
import { CSV_LEAD_COLUMNS, parseCsv, toCsv } from './csv';
import { canTransitionStage, LEAD_STAGES } from './lead-stages';
import {
  CreateLeadDto,
  CreateOutreachDraftDto,
  CsvImportConfirmDto,
  GenerateOutreachDto,
  ListLeadsQueryDto,
  ScoreLeadDto,
  TransitionLeadDto,
  UpdateLeadDto,
  UpdateOutreachDraftDto,
} from './leads.dto';
import { labelForScore, rubricPublicView, SCORING_RUBRIC_VERSION, validateCriterionScores } from './scoring-rubric';
import { canonicalizeUrl, isHttpUrl } from './url';
import { z } from 'zod';

const MANUAL_KEY = MANUAL_IMPORT_SOURCE_KEY;

const listInclude = {
  assignedAgent: { select: { id: true, key: true, name: true, kind: true } },
  sources: {
    orderBy: { discoveredAt: 'desc' as const },
    take: 3,
    include: { source: { select: { id: true, key: true, name: true, platform: true, accessMethod: true } } },
  },
  _count: { select: { messages: true, scores: true } },
} satisfies Prisma.LeadInclude;

const detailInclude = {
  assignedAgent: { select: { id: true, key: true, name: true, kind: true } },
  sources: {
    orderBy: { discoveredAt: 'desc' as const },
    include: { source: { select: { id: true, key: true, name: true, platform: true, accessMethod: true, isEnabled: true } } },
  },
  scores: { orderBy: { createdAt: 'desc' as const }, take: 20, include: { scoredBy: { select: { id: true, name: true } } } },
  messages: { orderBy: { createdAt: 'desc' as const }, take: 50 },
  outreachEvents: { orderBy: { occurredAt: 'desc' as const }, take: 50 },
} satisfies Prisma.LeadInclude;

export type LeadListItem = Prisma.LeadGetPayload<{ include: typeof listInclude }>;
export type LeadDetail = Prisma.LeadGetPayload<{ include: typeof detailInclude }>;

const outreachDraftSchema = z.object({
  subject: z.string().max(300),
  body: z.string().min(10).max(8000),
  rationale: z.string().max(2000),
});

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {}

  rubric() {
    return rubricPublicView();
  }

  stages() {
    return LEAD_STAGES;
  }

  async list(q: ListLeadsQueryDto): Promise<Page<LeadListItem>> {
    const where = this.buildWhere(q);
    const orderBy = this.buildOrder(q);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: listInclude,
      }),
      this.prisma.lead.count({ where }),
    ]);
    return toPage(items, total, q.page, q.pageSize);
  }

  async pipeline(q: Pick<ListLeadsQueryDto, 'sourceId' | 'from' | 'to' | 'minScore' | 'maxScore' | 'search' | 'assignedAgentId'>) {
    const where = this.buildWhere({ ...q, page: 1, pageSize: 25, sortBy: 'createdAt', sortDir: 'desc' });
    const grouped = await this.prisma.lead.groupBy({ by: ['stage'], where, _count: { _all: true } });
    const byStage = Object.fromEntries(grouped.map((g) => [g.stage, g._count._all]));
    const columns = await Promise.all(
      LEAD_STAGES.map(async (stage) => {
        const items = await this.prisma.lead.findMany({
          where: { ...where, stage },
          orderBy: [{ latestScore: 'desc' }, { updatedAt: 'desc' }],
          take: 40,
          include: listInclude,
        });
        return { stage, count: byStage[stage] ?? 0, items };
      }),
    );
    return { columns };
  }

  async get(id: string): Promise<LeadDetail> {
    const lead = await this.prisma.lead.findUnique({ where: { id }, include: detailInclude });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async briefing(id: string) {
    const lead = await this.get(id);
    const primary = lead.sources[0] ?? null;
    return {
      lead: {
        id: lead.id,
        name: lead.name,
        contactName: lead.contactName,
        contactEmail: lead.contactEmail,
        contactUrl: lead.contactUrl,
        websiteUrl: lead.websiteUrl,
        country: lead.country,
        industry: lead.industry,
        stage: lead.stage,
        intentLabel: lead.intentLabel,
        latestScore: lead.latestScore,
        requirements: lead.requirements,
        requestedSkills: lead.requestedSkills,
        budgetText: lead.budgetText,
        notes: lead.notes,
        doNotContact: lead.doNotContact,
        assignedAgent: lead.assignedAgent,
      },
      sources: lead.sources.map((s) => ({
        id: s.id,
        url: s.url,
        canonicalUrl: s.canonicalUrl,
        postDate: s.postDate,
        discoveredAt: s.discoveredAt,
        accessMethod: s.accessMethod,
        externalId: s.externalId,
        source: s.source,
        isManualImport: s.source.key === MANUAL_KEY || s.accessMethod === 'MANUAL_IMPORT',
      })),
      qualification: lead.scores[0]
        ? {
            score: lead.scores[0].score,
            label: lead.scores[0].label,
            reasons: lead.scores[0].reasons,
            rubricVersion: lead.scores[0].rubricVersion,
            scoredAt: lead.scores[0].createdAt,
            scoredBy: lead.scores[0].scoredBy,
          }
        : null,
      conversationNotes: lead.outreachEvents
        .filter((e) => e.type === 'NOTE' || e.type === 'REPLY_RECEIVED' || e.type === 'OPT_OUT' || e.type === 'SENT')
        .map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, data: e.data })),
      conversationHistory: lead.messages.map((m) => ({
        id: m.id,
        channel: m.channel,
        subject: m.subject,
        body: m.body,
        status: m.status,
        isFollowUp: m.isFollowUp,
        sentAt: m.sentAt,
        createdAt: m.createdAt,
      })),
      outreachDrafts: lead.messages.map((m) => ({
        id: m.id,
        channel: m.channel,
        subject: m.subject,
        status: m.status,
        createdAt: m.createdAt,
      })),
      originalRequest: lead.requirements,
      questionsToAsk: buildQuestionsToAsk(lead),
      demoPrep: {
        points: buildDemoPrep(lead),
        demoScheduledAt: lead.demoScheduledAt,
      },
      primarySource: primary
        ? {
            url: primary.url,
            sourceName: primary.source.name,
            isManualImport: primary.source.key === MANUAL_KEY,
          }
        : null,
      company: {
        name: lead.name,
        websiteUrl: lead.websiteUrl,
        industry: lead.industry,
        country: lead.country,
        contactName: lead.contactName,
        contactEmail: lead.contactEmail,
      },
    };
  }

  /**
   * Connector / job path: create or report duplicate without throwing.
   * Uses SYSTEM audit actor. Does not fabricate fields beyond the candidate payload.
   */
  async ingestFromConnector(
    dto: CreateLeadDto,
    snapshot?: Record<string, unknown> | null,
  ): Promise<{ created: boolean; leadId: string; duplicate: boolean; match?: string }> {
    const prepared = await this.prepareLeadInput(dto);
    if (prepared.duplicate) {
      return { created: false, leadId: prepared.duplicate.leadId, duplicate: true, match: prepared.duplicate.match };
    }

    const id = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          name: prepared.name,
          contactName: prepared.contactName,
          contactEmail: prepared.contactEmail,
          contactUrl: prepared.contactUrl,
          websiteUrl: prepared.websiteUrl,
          country: prepared.country,
          industry: prepared.industry,
          requirements: prepared.requirements,
          requestedSkills: prepared.requestedSkills,
          budgetText: prepared.budgetText,
          stage: prepared.stage,
          notes: prepared.notes,
          assignedAgentId: prepared.assignedAgentId,
          sources: {
            create: {
              sourceId: prepared.sourceId,
              externalId: prepared.externalId,
              url: prepared.sourceUrl,
              canonicalUrl: prepared.canonicalUrl,
              postDate: prepared.postDate,
              discoveredAt: prepared.discoveredAt,
              accessMethod: prepared.accessMethod,
              ...(snapshot ? { snapshot: snapshot as Prisma.InputJsonValue } : {}),
            },
          },
        },
      });
      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'lead.ingest_connector',
          entityType: 'lead',
          entityId: lead.id,
          data: { name: lead.name, sourceId: prepared.sourceId, externalId: prepared.externalId },
        },
        tx,
      );
      return lead.id;
    });

    this.events.emit({ type: 'lead.created', leadId: id });
    return { created: true, leadId: id, duplicate: false };
  }

  async create(dto: CreateLeadDto, user: AuthUser, ctx: RequestContext): Promise<LeadDetail> {
    const prepared = await this.prepareLeadInput(dto);
    if (prepared.duplicate) {
      throw new ConflictException({
        message: 'A lead with this source URL or external id already exists.',
        existingLeadId: prepared.duplicate.leadId,
        match: prepared.duplicate.match,
      });
    }

    const id = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          name: prepared.name,
          contactName: prepared.contactName,
          contactEmail: prepared.contactEmail,
          contactUrl: prepared.contactUrl,
          websiteUrl: prepared.websiteUrl,
          country: prepared.country,
          industry: prepared.industry,
          requirements: prepared.requirements,
          requestedSkills: prepared.requestedSkills,
          budgetText: prepared.budgetText,
          stage: prepared.stage,
          notes: prepared.notes,
          assignedAgentId: prepared.assignedAgentId,
          doNotContact: prepared.stage === 'DO_NOT_CONTACT',
          sources: {
            create: {
              sourceId: prepared.sourceId,
              externalId: prepared.externalId,
              url: prepared.sourceUrl,
              canonicalUrl: prepared.canonicalUrl,
              postDate: prepared.postDate,
              discoveredAt: prepared.discoveredAt,
              accessMethod: prepared.accessMethod,
            },
          },
        },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'lead.create',
          entityType: 'lead',
          entityId: lead.id,
          data: { name: lead.name, sourceId: prepared.sourceId, manual: prepared.accessMethod === 'MANUAL_IMPORT' },
          ctx,
        },
        tx,
      );
      return lead.id;
    });

    this.events.emit({ type: 'lead.created', leadId: id });
    return this.get(id);
  }

  async update(id: string, dto: UpdateLeadDto, user: AuthUser, ctx: RequestContext): Promise<LeadDetail> {
    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Lead not found');
    if (existing.doNotContact && dto.doNotContact === false) {
      throw new BadRequestException('Re-enable contact only by moving the lead out of Do Not Contact via a stage change.');
    }
    if (dto.assignedAgentId) await this.assertAgent(dto.assignedAgentId);

    const data: Prisma.LeadUpdateInput = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.contactName !== undefined && { contactName: dto.contactName }),
      ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
      ...(dto.contactUrl !== undefined && { contactUrl: dto.contactUrl }),
      ...(dto.websiteUrl !== undefined && { websiteUrl: dto.websiteUrl }),
      ...(dto.country !== undefined && { country: dto.country }),
      ...(dto.industry !== undefined && { industry: dto.industry }),
      ...(dto.requirements !== undefined && { requirements: dto.requirements }),
      ...(dto.requestedSkills !== undefined && { requestedSkills: dto.requestedSkills }),
      ...(dto.budgetText !== undefined && { budgetText: dto.budgetText }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.doNotContact !== undefined && { doNotContact: dto.doNotContact, ...(dto.doNotContact ? { stage: 'DO_NOT_CONTACT' as LeadStage, optedOutAt: new Date() } : {}) }),
      ...(dto.assignedAgentId !== undefined && {
        assignedAgent: dto.assignedAgentId ? { connect: { id: dto.assignedAgentId } } : { disconnect: true },
      }),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id }, data });
      await this.audit.record(
        { actorType: 'USER', actorUserId: user.id, action: 'lead.update', entityType: 'lead', entityId: id, data: { ...dto }, ctx },
        tx,
      );
    });
    this.events.emit({ type: 'lead.updated', leadId: id });
    return this.get(id);
  }

  async transition(id: string, dto: TransitionLeadDto, user: AuthUser, ctx: RequestContext): Promise<LeadDetail> {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (dto.to === 'WON') {
      throw new BadRequestException(
        'Marking a deal Won requires confirmed project scope. Use POST /leads/:id/confirm-deal with scope and deal value.',
      );
    }
    const check = canTransitionStage(lead.stage, dto.to);
    if (!check.ok) throw new BadRequestException(check.reason);

    const now = new Date();
    const data: Prisma.LeadUpdateInput = { stage: dto.to };
    if (dto.to === 'DO_NOT_CONTACT') {
      data.doNotContact = true;
      data.optedOutAt = now;
    }
    if (dto.to === 'LOST') {
      data.lostAt = now;
      data.lostReason = dto.lostReason?.trim() || dto.message?.trim() || null;
    }
    if (lead.stage === 'DO_NOT_CONTACT' && dto.to !== 'DO_NOT_CONTACT') {
      data.doNotContact = false;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id }, data });
      if (dto.to === 'DO_NOT_CONTACT') {
        await tx.outreachMessage.updateMany({
          where: { leadId: id, status: { in: ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED'] } },
          data: { status: 'CANCELLED' },
        });
        await tx.outreachEvent.create({
          data: { leadId: id, type: 'OPT_OUT', data: { via: 'stage_transition' } },
        });
      }
      await tx.outreachEvent.create({
        data: {
          leadId: id,
          type: 'NOTE',
          data: { kind: 'stage_change', from: lead.stage, to: dto.to, message: dto.message ?? null } as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'lead.transition',
          entityType: 'lead',
          entityId: id,
          data: { from: lead.stage, to: dto.to, message: dto.message },
          ctx,
        },
        tx,
      );
    });
    this.events.emit({ type: 'lead.updated', leadId: id });
    return this.get(id);
  }

  async score(id: string, dto: ScoreLeadDto, user: AuthUser, ctx: RequestContext): Promise<LeadDetail> {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    const validated = validateCriterionScores(dto.criteria);
    if (!validated.ok) throw new BadRequestException(validated.error);

    const label = labelForScore(validated.total);
    await this.prisma.$transaction(async (tx) => {
      await tx.leadScore.create({
        data: {
          leadId: id,
          score: validated.total,
          label,
          reasons: validated.reasons as unknown as Prisma.InputJsonValue,
          rubricVersion: SCORING_RUBRIC_VERSION,
          scoredById: user.id,
        },
      });
      await tx.lead.update({
        where: { id },
        data: {
          latestScore: validated.total,
          intentLabel: label,
          ...(lead.stage === 'NEW' ? { stage: 'QUALIFIED' } : {}),
        },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'lead.score',
          entityType: 'lead',
          entityId: id,
          data: { score: validated.total, label, rubricVersion: SCORING_RUBRIC_VERSION },
          ctx,
        },
        tx,
      );
    });
    this.events.emit({ type: 'lead.updated', leadId: id });
    return this.get(id);
  }

  async previewImport(csvText: string, sourceKey?: string) {
    const { headers, rows } = parseCsv(csvText);
    if (!headers.length) throw new BadRequestException('CSV is empty.');
    if (!headers.includes('name') || !headers.includes('source_url')) {
      throw new BadRequestException('CSV must include at least name and source_url columns.');
    }
    const unknown = headers.filter((h) => h && !(CSV_LEAD_COLUMNS as readonly string[]).includes(h));
    const source = await this.resolveImportSource(sourceKey);
    const isManualImport = source.accessMethod === 'MANUAL_IMPORT';

    const preview = [];
    const seenCanonical = new Set<string>();
    const seenExternal = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2;
      const map = Object.fromEntries(headers.map((h, idx) => [h, rows[i]![idx]?.trim() ?? '']));
      const errors: string[] = [];
      const name = map.name ?? '';
      const sourceUrl = map.source_url ?? '';
      if (!name || name.length < 2) errors.push('name is required (min 2 characters).');
      if (!sourceUrl) errors.push('source_url is required.');
      const canonical = sourceUrl ? canonicalizeUrl(sourceUrl) : null;
      if (sourceUrl && !canonical) errors.push('source_url is not a valid http(s) URL.');
      if (map.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(map.contact_email)) errors.push('contact_email is invalid.');
      if (map.stage && !LEAD_STAGES.includes(map.stage.toUpperCase() as LeadStage)) errors.push(`Unknown stage "${map.stage}".`);
      if (map.post_date && Number.isNaN(Date.parse(map.post_date))) errors.push('post_date is not a valid date.');
      if (map.discovered_at && Number.isNaN(Date.parse(map.discovered_at))) errors.push('discovered_at is not a valid date.');

      let duplicate: { leadId: string; match: string } | null = null;
      if (canonical && !errors.length) {
        if (seenCanonical.has(canonical)) {
          errors.push('Duplicate source_url within this CSV.');
        }
        const ext = map.external_id || '';
        if (ext && seenExternal.has(ext)) {
          errors.push('Duplicate external_id within this CSV.');
        }
        duplicate = await this.findDuplicate(source.id, canonical, map.external_id || null);
        if (duplicate) errors.push(`Duplicate of existing lead (${duplicate.match}).`);
        if (!errors.length) {
          seenCanonical.add(canonical);
          if (ext) seenExternal.add(ext);
        }
      }

      const dto: CreateLeadDto | null =
        errors.length === 0
          ? {
              name,
              contactName: map.contact_name || undefined,
              contactEmail: map.contact_email || undefined,
              contactUrl: map.contact_url || undefined,
              websiteUrl: map.website_url || undefined,
              country: map.country || undefined,
              industry: map.industry || undefined,
              requirements: map.requirements || undefined,
              requestedSkills: map.requested_skills ? map.requested_skills.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : undefined,
              budgetText: map.budget_text || undefined,
              notes: map.notes || undefined,
              sourceUrl,
              externalId: map.external_id || undefined,
              postDate: map.post_date || undefined,
              discoveredAt: map.discovered_at || undefined,
              stage: map.stage ? (map.stage.toUpperCase() as LeadStage) : 'NEW',
              sourceId: source.id,
            }
          : null;

      preview.push({
        row: rowNum,
        data: dto,
        raw: map,
        errors,
        duplicate,
        isManualImport,
      });
    }

    return {
      headers,
      unknownColumns: unknown,
      isManualImport,
      source: { id: source.id, key: source.key, name: source.name, accessMethod: source.accessMethod },
      rows: preview,
      validCount: preview.filter((r) => r.errors.length === 0).length,
      errorCount: preview.filter((r) => r.errors.length > 0).length,
    };
  }

  async confirmImport(dto: CsvImportConfirmDto, user: AuthUser, ctx: RequestContext) {
    if (!dto.rows.length) throw new BadRequestException('No rows to import.');
    const created: string[] = [];
    const skipped: { index: number; reason: string; existingLeadId?: string }[] = [];

    for (let i = 0; i < dto.rows.length; i++) {
      try {
        const lead = await this.create(dto.rows[i]!, user, ctx);
        created.push(lead.id);
      } catch (err) {
        if (err instanceof ConflictException) {
          const body = err.getResponse() as { existingLeadId?: string; message?: string };
          skipped.push({ index: i, reason: typeof body === 'object' ? String(body.message) : 'Duplicate', existingLeadId: body.existingLeadId });
        } else if (err instanceof BadRequestException) {
          skipped.push({ index: i, reason: String((err.getResponse() as { message?: string }).message ?? err.message) });
        } else {
          throw err;
        }
      }
    }

    return { createdCount: created.length, createdIds: created, skipped };
  }

  async exportCsv(q: ListLeadsQueryDto): Promise<string> {
    const where = this.buildWhere(q);
    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: this.buildOrder(q),
      take: 5000,
      include: {
        sources: {
          orderBy: { discoveredAt: 'desc' },
          take: 1,
          include: { source: { select: { key: true, name: true } } },
        },
      },
    });
    const headers = [...CSV_LEAD_COLUMNS, 'id', 'latest_score', 'intent_label', 'source_key'];
    const rows = leads.map((l) => {
      const s = l.sources[0];
      return [
        l.name,
        l.contactName,
        l.contactEmail,
        l.contactUrl,
        l.websiteUrl,
        l.country,
        l.industry,
        l.requirements,
        l.requestedSkills.join('; '),
        l.budgetText,
        l.notes,
        s?.url ?? '',
        s?.externalId ?? '',
        s?.postDate?.toISOString() ?? '',
        s?.discoveredAt.toISOString() ?? '',
        l.stage,
        l.id,
        l.latestScore,
        l.intentLabel,
        s?.source.key ?? '',
      ];
    });
    return toCsv(headers, rows);
  }

  async listDrafts(leadId: string) {
    await this.ensureLead(leadId);
    return this.prisma.outreachMessage.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createDraft(leadId: string, dto: CreateOutreachDraftDto, user: AuthUser, ctx: RequestContext) {
    const lead = await this.ensureLead(leadId);
    if (lead.doNotContact) throw new BadRequestException('Cannot create outreach for a do-not-contact lead.');

    let subject = dto.subject ?? null;
    let body = dto.body;
    let rationale = dto.rationale ?? '';
    let channel: OutreachChannel = dto.channel ?? 'EMAIL';

    if (dto.generateWithAi) {
      const generated = await this.generateDraftContent(lead, { channel, extraContext: dto.rationale });
      subject = generated.subject;
      body = generated.body;
      rationale = generated.rationale;
      channel = generated.channel;
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.outreachMessage.create({
        data: {
          leadId,
          channel,
          subject,
          body,
          rationale,
          status: 'DRAFT',
        },
      });
      await tx.outreachEvent.create({
        data: { leadId, messageId: msg.id, type: 'DRAFT_CREATED', data: { channel, ai: Boolean(dto.generateWithAi) } },
      });
      if (lead.stage === 'NEW' || lead.stage === 'QUALIFIED') {
        await tx.lead.update({ where: { id: leadId }, data: { stage: 'DRAFT_READY' } });
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'outreach.draft_create',
          entityType: 'outreach_message',
          entityId: msg.id,
          data: { leadId, channel, ai: Boolean(dto.generateWithAi) },
          ctx,
        },
        tx,
      );
      return msg;
    });
    this.events.emit({ type: 'lead.updated', leadId });
    return message;
  }

  async generateDraft(leadId: string, dto: GenerateOutreachDto, user: AuthUser, ctx: RequestContext) {
    const lead = await this.get(leadId);
    if (lead.doNotContact) throw new BadRequestException('Cannot create outreach for a do-not-contact lead.');
    const generated = await this.generateDraftContent(lead, dto);
    return this.createDraft(
      leadId,
      {
        channel: generated.channel,
        subject: generated.subject,
        body: generated.body,
        rationale: generated.rationale,
        generateWithAi: false,
      },
      user,
      ctx,
    );
  }

  async updateDraft(leadId: string, messageId: string, dto: UpdateOutreachDraftDto, user: AuthUser, ctx: RequestContext) {
    await this.ensureLead(leadId);
    const msg = await this.prisma.outreachMessage.findFirst({ where: { id: messageId, leadId } });
    if (!msg) throw new NotFoundException('Outreach draft not found');
    if (msg.status === 'SENT') throw new BadRequestException('Sent messages cannot be edited in this phase.');

    if (dto.status === 'SENT' || dto.status === 'SCHEDULED') {
      throw new BadRequestException(
        'Use request-send (CEO approval) to send email, or schedule a follow-up via /follow-ups. Direct SENT/SCHEDULED status patches are not allowed.',
      );
    }
    if (dto.status === 'APPROVED') {
      throw new BadRequestException('Approval must go through the Approvals inbox (POST /approvals/:id/decide).');
    }
    if (dto.status && !['DRAFT', 'AWAITING_APPROVAL', 'CANCELLED', 'FAILED'].includes(dto.status)) {
      throw new BadRequestException(`Cannot set outreach status to ${dto.status} via draft update.`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.outreachMessage.update({
        where: { id: messageId },
        data: {
          ...(dto.subject !== undefined && { subject: dto.subject }),
          ...(dto.body !== undefined && { body: dto.body }),
          ...(dto.rationale !== undefined && { rationale: dto.rationale }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
      });
      if (dto.status === 'AWAITING_APPROVAL') {
        await tx.outreachEvent.create({
          data: { leadId, messageId, type: 'APPROVAL_REQUESTED' },
        });
        await tx.lead.update({ where: { id: leadId }, data: { stage: 'AWAITING_APPROVAL' } });
      }
      if (dto.status === 'APPROVED') {
        await tx.outreachEvent.create({ data: { leadId, messageId, type: 'APPROVED' } });
      }
      if (dto.status === 'CANCELLED') {
        // no-op event
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'outreach.draft_update',
          entityType: 'outreach_message',
          entityId: messageId,
          data: { ...dto },
          ctx,
        },
        tx,
      );
      return next;
    });
    this.events.emit({ type: 'lead.updated', leadId });
    return updated;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private buildWhere(q: Partial<ListLeadsQueryDto>): Prisma.LeadWhereInput {
    return {
      ...(q.stage?.length && { stage: { in: q.stage } }),
      ...(q.assignedAgentId && { assignedAgentId: q.assignedAgentId }),
      ...(q.doNotContact !== undefined && { doNotContact: q.doNotContact }),
      ...((q.minScore !== undefined || q.maxScore !== undefined) && {
        latestScore: {
          ...(q.minScore !== undefined && { gte: q.minScore }),
          ...(q.maxScore !== undefined && { lte: q.maxScore }),
        },
      }),
      ...(q.sourceId && { sources: { some: { sourceId: q.sourceId } } }),
      ...((q.from || q.to) && {
        createdAt: {
          ...(q.from && { gte: new Date(q.from) }),
          ...(q.to && { lte: new Date(q.to) }),
        },
      }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { contactName: { contains: q.search, mode: 'insensitive' } },
          { contactEmail: { contains: q.search, mode: 'insensitive' } },
          { requirements: { contains: q.search, mode: 'insensitive' } },
          { notes: { contains: q.search, mode: 'insensitive' } },
          { websiteUrl: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };
  }

  private buildOrder(q: ListLeadsQueryDto): Prisma.LeadOrderByWithRelationInput[] {
    const dir = q.sortDir;
    if (q.sortBy === 'discoveredAt') {
      return [{ sources: { _count: dir } }, { createdAt: dir }, { id: 'asc' }];
    }
    if (q.sortBy === 'latestScore') return [{ latestScore: { sort: dir, nulls: 'last' } }, { id: 'asc' }];
    if (q.sortBy === 'name') return [{ name: dir }, { id: 'asc' }];
    if (q.sortBy === 'stage') return [{ stage: dir }, { id: 'asc' }];
    if (q.sortBy === 'updatedAt') return [{ updatedAt: dir }, { id: 'asc' }];
    return [{ createdAt: dir }, { id: 'asc' }];
  }

  private async prepareLeadInput(dto: CreateLeadDto) {
    if (!isHttpUrl(dto.sourceUrl)) throw new BadRequestException('sourceUrl must be a valid http(s) URL.');
    const canonicalUrl = canonicalizeUrl(dto.sourceUrl)!;
    if (dto.websiteUrl && !isHttpUrl(dto.websiteUrl)) throw new BadRequestException('websiteUrl must be a valid http(s) URL.');
    if (dto.contactUrl && !isHttpUrl(dto.contactUrl)) throw new BadRequestException('contactUrl must be a valid http(s) URL.');
    if (dto.assignedAgentId) await this.assertAgent(dto.assignedAgentId);

    const source = dto.sourceId
      ? await this.prisma.source.findUnique({ where: { id: dto.sourceId } })
      : await this.manualSource();
    if (!source) throw new BadRequestException('Source not found');

    const externalId = dto.externalId?.trim() || null;
    const duplicate = await this.findDuplicate(source.id, canonicalUrl, externalId);

    return {
      name: dto.name.trim(),
      contactName: dto.contactName?.trim() || null,
      contactEmail: dto.contactEmail?.trim().toLowerCase() || null,
      contactUrl: dto.contactUrl?.trim() || null,
      websiteUrl: dto.websiteUrl?.trim() || null,
      country: dto.country?.trim() || null,
      industry: dto.industry?.trim() || null,
      requirements: dto.requirements?.trim() || '',
      requestedSkills: dto.requestedSkills ?? [],
      budgetText: dto.budgetText?.trim() || null,
      notes: dto.notes?.trim() || '',
      stage: dto.stage ?? 'NEW',
      assignedAgentId: dto.assignedAgentId ?? null,
      sourceId: source.id,
      sourceUrl: dto.sourceUrl.trim(),
      canonicalUrl,
      externalId,
      postDate: dto.postDate ? new Date(dto.postDate) : null,
      discoveredAt: dto.discoveredAt ? new Date(dto.discoveredAt) : new Date(),
      accessMethod: source.accessMethod,
      duplicate,
    };
  }

  private async findDuplicate(sourceId: string, canonicalUrl: string, externalId: string | null) {
    if (externalId) {
      const byExt = await this.prisma.leadSource.findUnique({
        where: { sourceId_externalId: { sourceId, externalId } },
        select: { leadId: true },
      });
      if (byExt) return { leadId: byExt.leadId, match: 'external_id' };
    }
    const byUrl = await this.prisma.leadSource.findUnique({
      where: { sourceId_canonicalUrl: { sourceId, canonicalUrl } },
      select: { leadId: true },
    });
    if (byUrl) return { leadId: byUrl.leadId, match: 'canonical_url' };
    return null;
  }

  private async manualSource() {
    const source = await this.prisma.source.findUnique({ where: { key: MANUAL_KEY } });
    if (!source) throw new BadRequestException('Manual import source is not seeded.');
    return source;
  }

  /** Resolve CSV import attribution. Only MANUAL_IMPORT sources (or default manual) are allowed. */
  private async resolveImportSource(sourceKey?: string) {
    const key = sourceKey?.trim() || MANUAL_KEY;
    const source = await this.prisma.source.findUnique({ where: { key } });
    if (!source) throw new BadRequestException(`Unknown import source "${key}".`);
    if (source.accessMethod !== 'MANUAL_IMPORT') {
      throw new BadRequestException(
        `Source "${source.name}" is a live connector — use Scan on Sources, or import under an Import-only source.`,
      );
    }
    if (!source.isEnabled) throw new BadRequestException(`Source "${source.name}" is disabled.`);
    return source;
  }

  private async assertAgent(id: string) {
    const agent = await this.prisma.agentDefinition.findUnique({ where: { id }, select: { isEnabled: true, name: true } });
    if (!agent) throw new BadRequestException('Assigned agent not found');
    if (!agent.isEnabled) throw new BadRequestException(`${agent.name} is disabled`);
  }

  private async ensureLead(id: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private async generateDraftContent(
    lead: LeadDetail | Awaited<ReturnType<typeof this.ensureLead>>,
    dto: GenerateOutreachDto,
  ) {
    try {
      this.ai.assertReady();
    } catch (err) {
      if (err instanceof AiCredentialsError) throw new ServiceUnavailableException(err.message);
      throw err;
    }

    const detail = 'sources' in lead ? lead : await this.get(lead.id);
    const sourceUrls = detail.sources.map((s) => s.url).join('\n') || '(none)';
    const channel: OutreachChannel = dto.channel ?? 'EMAIL';

    try {
      const result = await this.ai.completeStructured({
        tier: 'ROUTINE',
        maxOutputTokens: 1200,
        schema: outreachDraftSchema,
        schemaName: 'outreach_draft',
        messages: [
          {
            role: 'system',
            content: [
              'You write personalized outreach drafts for a web development agency.',
              'Refer only to facts present in the lead record and source URLs.',
              'Never invent familiarity, budgets, or claims.',
              'Do not include fake tracking links. Keep the tone concise and professional.',
              'This draft will NOT be sent automatically — it is for CEO review.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Channel: ${channel}`,
              `Company/profile: ${detail.name}`,
              `Contact: ${detail.contactName ?? 'unknown'}`,
              `Requirements: ${detail.requirements || '(none stated)'}`,
              `Skills: ${detail.requestedSkills.join(', ') || '(none)'}`,
              `Budget (only if stated): ${detail.budgetText ?? '(not stated)'}`,
              `Notes: ${detail.notes || '(none)'}`,
              `Source URLs:\n${sourceUrls}`,
              dto.extraContext ? `Extra context from CEO: ${dto.extraContext}` : '',
              'Write subject, body, and a short rationale.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });
      return { ...result.data, channel };
    } catch (err) {
      if (err instanceof AiCredentialsError) throw new ServiceUnavailableException(err.message);
      if (err instanceof AiOutputValidationError) throw new BadRequestException(err.message);
      if (err instanceof AiProviderError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }
}

function buildDemoPrep(lead: LeadDetail): string[] {
  const points: string[] = [];
  if (lead.requirements) points.push(`Discuss stated requirements: ${lead.requirements.slice(0, 240)}`);
  if (lead.requestedSkills.length) points.push(`Requested skills: ${lead.requestedSkills.join(', ')}`);
  if (lead.budgetText) points.push(`Prospect-stated budget: ${lead.budgetText}`);
  else points.push('No budget was stated — do not invent one; ask in the demo if appropriate.');
  if (lead.websiteUrl) points.push(`Review existing site: ${lead.websiteUrl}`);
  const src = lead.sources[0];
  if (src) points.push(`Open original source before the call: ${src.url}`);
  if (lead.latestScore != null) points.push(`Qualification score ${lead.latestScore}/100 (${lead.intentLabel ?? 'unlabeled'})`);
  if (lead.notes) points.push(`Internal notes: ${lead.notes.slice(0, 240)}`);
  points.push('Do not commit to final pricing or binding terms without CEO confirmation.');
  if (!points.length) points.push('Gather more requirements before scheduling a demo.');
  return points;
}

function buildQuestionsToAsk(lead: LeadDetail): string[] {
  const qs: string[] = [
    'What problem are you trying to solve, and what does success look like?',
    'What is the timeline and who is the decision-maker?',
  ];
  if (!lead.budgetText) qs.push('Is there a budget range you are comfortable sharing? (Do not invent one.)');
  if (!lead.requestedSkills.length) qs.push('Which technologies or platforms are required or preferred?');
  if (lead.websiteUrl) qs.push('What should stay vs change on the existing site?');
  else qs.push('Do you have brand assets, copy, or a current site we should review?');
  return qs;
}
