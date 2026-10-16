import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { OutreachStatus } from '../generated/prisma/client';
import { AI_PROVIDER, type AiProvider } from '../ai/ai.types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { AppConfigService } from '../config/app-config.service';
import { EmailNotConfiguredError, EmailProviderError } from '../email/email.types';
import { EmailService } from '../email/email.service';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { classifyReplyWithAi } from './reply-classifier';
import type { ConfirmDealDto, IngestReplyDto, RequestSendDto, ScheduleFollowUpDto } from './outreach.dto';

const ACTIVE_FOLLOW_UP: OutreachStatus[] = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED'];

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly config: AppConfigService,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
  ) {}

  providerStatus() {
    return this.email.status();
  }

  /** CEO requests send → creates Approval (required). Does not send. */
  async requestSend(leadId: string, messageId: string, dto: RequestSendDto, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    const { lead, message } = await this.loadMessage(leadId, messageId);
    this.assertCanOutreach(lead);
    if (!['DRAFT', 'APPROVED', 'FAILED', 'SCHEDULED'].includes(message.status)) {
      throw new BadRequestException(`Cannot request send from status ${message.status}.`);
    }
    if (message.channel !== 'EMAIL') {
      throw new BadRequestException('Only EMAIL channel sends are supported in this phase.');
    }

    const recipient = (dto.recipientEmail ?? lead.contactEmail ?? '').trim().toLowerCase();
    if (!recipient || !isEmail(recipient)) {
      throw new BadRequestException('Lead has no authorized recipient email. Add a verified contact email first.');
    }
    if (lead.contactEmail && recipient !== lead.contactEmail.trim().toLowerCase()) {
      throw new BadRequestException('Recipient must match the lead’s stored contact email (authorized recipient only).');
    }
    if (!message.subject?.trim()) throw new BadRequestException('Subject is required before requesting send.');

    const existing = await this.prisma.approval.findFirst({
      where: {
        actionType: 'SEND_EXTERNAL_MESSAGE',
        entityType: 'outreach_message',
        entityId: messageId,
        status: 'PENDING',
      },
    });
    if (existing) {
      return { approvalId: existing.id, messageId, status: 'AWAITING_APPROVAL' as const, deduplicated: true };
    }

    const approval = await this.prisma.$transaction(async (tx) => {
      const a = await tx.approval.create({
        data: {
          actionType: 'SEND_EXTERNAL_MESSAGE',
          status: 'PENDING',
          entityType: 'outreach_message',
          entityId: messageId,
          summary: `Send email to ${recipient}: ${message.subject}`,
          payload: {
            leadId,
            messageId,
            recipientEmail: recipient,
            subject: message.subject,
            channel: message.channel,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.outreachMessage.update({
        where: { id: messageId },
        data: { status: 'AWAITING_APPROVAL', recipientEmail: recipient, approvalId: a.id },
      });
      await tx.outreachEvent.create({ data: { leadId, messageId, type: 'APPROVAL_REQUESTED', data: { approvalId: a.id } } });
      await tx.lead.update({ where: { id: leadId }, data: { stage: 'AWAITING_APPROVAL' } });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'outreach.request_send',
          entityType: 'outreach_message',
          entityId: messageId,
          data: { approvalId: a.id, recipient },
          ctx,
        },
        tx,
      );
      return a;
    });

    await this.notifications.notifyCeo({
      type: 'APPROVAL_REQUIRED',
      title: 'Outreach send awaiting approval',
      body: `Approve sending “${message.subject}” to ${recipient}.`,
      link: `/approvals/${approval.id}`,
      dedupeKey: `approval:${approval.id}`,
    });

    this.events.emit({ type: 'approval.updated', approvalId: approval.id, status: 'PENDING' });
    this.events.emit({ type: 'lead.updated', leadId });
    return { approvalId: approval.id, messageId, status: 'AWAITING_APPROVAL' as const, deduplicated: false };
  }

  /** Execute send only after an APPROVED SEND_EXTERNAL_MESSAGE approval. */
  async executeApprovedSend(approvalId: string, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) throw new NotFoundException('Approval not found');
    if (approval.actionType !== 'SEND_EXTERNAL_MESSAGE') throw new BadRequestException('Not an outreach send approval.');
    if (approval.status !== 'APPROVED') throw new BadRequestException('Approval is not APPROVED.');

    const payload = (approval.payload ?? {}) as { leadId?: string; messageId?: string; recipientEmail?: string };
    if (!payload.messageId || !payload.leadId || !payload.recipientEmail) {
      throw new BadRequestException('Approval payload is incomplete.');
    }

    const { lead, message } = await this.loadMessage(payload.leadId, payload.messageId);
    this.assertCanOutreach(lead);
    if (lead.outreachPausedAt) throw new BadRequestException('Outreach is paused for this lead.');
    if (message.status === 'SENT') {
      return { messageId: message.id, status: 'SENT' as const, providerMessageId: message.providerMessageId, deduplicated: true };
    }

    if (!this.email.activeProvider()) {
      throw new ServiceUnavailableException(
        'Email provider is not configured. Set EMAIL_PROVIDER=resend, RESEND_API_KEY, and EMAIL_FROM. Live delivery is not claimed until configured and tested.',
      );
    }

    try {
      const result = await this.email.send({
        to: payload.recipientEmail,
        subject: message.subject ?? '(no subject)',
        bodyText: appendOptOutFooter(message.body),
        idempotencyKey: `outreach:${message.id}`,
        inReplyTo: message.parentMessage?.providerMessageId ?? null,
      });

      await this.prisma.$transaction(async (tx) => {
        await tx.outreachMessage.update({
          where: { id: message.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            provider: result.provider,
            providerMessageId: result.messageId,
            deliveryStatus: result.deliveryStatus,
            lastProviderError: null,
            recipientEmail: payload.recipientEmail,
            approvalId: approvalId,
          },
        });
        await tx.outreachEvent.create({
          data: {
            leadId: lead.id,
            messageId: message.id,
            type: 'SENT',
            data: { provider: result.provider, providerMessageId: result.messageId },
          },
        });
        if (['NEW', 'QUALIFIED', 'DRAFT_READY', 'AWAITING_APPROVAL'].includes(lead.stage)) {
          await tx.lead.update({ where: { id: lead.id }, data: { stage: 'CONTACTED' } });
        }
        await this.audit.record(
          {
            actorType: 'USER',
            actorUserId: user.id,
            action: 'outreach.sent',
            entityType: 'outreach_message',
            entityId: message.id,
            data: { provider: result.provider, providerMessageId: result.messageId, approvalId },
            ctx,
          },
          tx,
        );
      });

      this.events.emit({ type: 'lead.updated', leadId: lead.id });
      return {
        messageId: message.id,
        status: 'SENT' as const,
        providerMessageId: result.messageId,
        deliveryStatus: result.deliveryStatus,
        deduplicated: false,
      };
    } catch (err) {
      const msg =
        err instanceof EmailProviderError || err instanceof EmailNotConfiguredError
          ? err.message
          : 'Email send failed';
      await this.prisma.$transaction(async (tx) => {
        await tx.outreachMessage.update({
          where: { id: message.id },
          data: { status: 'FAILED', lastProviderError: msg.slice(0, 2000), deliveryStatus: 'failed' },
        });
        await tx.outreachEvent.create({
          data: { leadId: lead.id, messageId: message.id, type: 'SEND_FAILED', data: { error: msg.slice(0, 500) } },
        });
      });
      this.events.emit({ type: 'lead.updated', leadId: lead.id });
      if (err instanceof EmailNotConfiguredError) throw new ServiceUnavailableException(err.message);
      throw new ServiceUnavailableException(msg);
    }
  }

  async scheduleFollowUp(leadId: string, dto: ScheduleFollowUpDto, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertCanOutreach(lead);

    const when = new Date(dto.scheduledFor);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('scheduledFor must be a valid future time.');
    }

    const parentId = dto.parentMessageId ?? null;
    if (parentId) {
      const parent = await this.prisma.outreachMessage.findFirst({ where: { id: parentId, leadId } });
      if (!parent) throw new BadRequestException('Parent message not found on this lead.');
    }

    // Duplicate prevention: same lead + parent + scheduled day + body prefix
    const dayStart = new Date(when);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const dup = await this.prisma.outreachMessage.findFirst({
      where: {
        leadId,
        isFollowUp: true,
        parentMessageId: parentId,
        status: { in: ACTIVE_FOLLOW_UP },
        scheduledFor: { gte: dayStart, lt: dayEnd },
        body: dto.body.trim(),
      },
    });
    if (dup) {
      return { message: dup, deduplicated: true };
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.outreachMessage.create({
        data: {
          leadId,
          channel: 'EMAIL',
          subject: dto.subject?.trim() || 'Follow-up',
          body: dto.body.trim(),
          rationale: dto.rationale?.trim() || 'Scheduled follow-up',
          status: 'SCHEDULED',
          isFollowUp: true,
          parentMessageId: parentId,
          scheduledFor: when,
          recipientEmail: lead.contactEmail,
        },
      });
      await tx.outreachEvent.create({
        data: { leadId, messageId: msg.id, type: 'FOLLOW_UP_DUE', data: { scheduledFor: when.toISOString() } },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'outreach.follow_up_schedule',
          entityType: 'outreach_message',
          entityId: msg.id,
          data: { scheduledFor: when.toISOString(), parentMessageId: parentId },
          ctx,
        },
        tx,
      );
      return msg;
    });

    this.events.emit({ type: 'lead.updated', leadId });
    return { message, deduplicated: false };
  }

  async pauseOutreach(leadId: string, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { outreachPausedAt: new Date() } });
      await this.cancelActiveFollowUps(tx, leadId, 'paused');
      await this.audit.record(
        { actorType: 'USER', actorUserId: user.id, action: 'outreach.pause', entityType: 'lead', entityId: leadId, ctx },
        tx,
      );
    });
    this.events.emit({ type: 'lead.updated', leadId });
    return this.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  }

  async resumeOutreach(leadId: string, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.doNotContact) throw new BadRequestException('Cannot resume outreach for a do-not-contact lead.');
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { outreachPausedAt: null } });
      await this.audit.record(
        { actorType: 'USER', actorUserId: user.id, action: 'outreach.resume', entityType: 'lead', entityId: leadId, ctx },
        tx,
      );
    });
    this.events.emit({ type: 'lead.updated', leadId });
    return this.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  }

  async stopScheduledOutreach(leadId: string, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    await this.prisma.$transaction(async (tx) => {
      const n = await this.cancelActiveFollowUps(tx, leadId, 'stopped');
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'outreach.stop_scheduled',
          entityType: 'lead',
          entityId: leadId,
          data: { cancelled: n },
          ctx,
        },
        tx,
      );
    });
    this.events.emit({ type: 'lead.updated', leadId });
    return { ok: true };
  }

  /** Due SCHEDULED messages → request CEO send approval (never auto-send without approval). */
  async processDueFollowUps(): Promise<number> {
    const due = await this.prisma.outreachMessage.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledFor: { lte: new Date() },
        lead: { doNotContact: false, outreachPausedAt: null, optedOutAt: null },
      },
      take: 25,
      include: { lead: true },
    });

    let processed = 0;
    for (const msg of due) {
      try {
        const ceo = await this.prisma.user.findFirst({ where: { role: 'CEO', isActive: true } });
        if (!ceo) break;
        await this.requestSend(
          msg.leadId,
          msg.id,
          { recipientEmail: msg.recipientEmail ?? msg.lead.contactEmail ?? undefined },
          { id: ceo.id, email: '', name: 'System', role: 'CEO' },
          { ip: null, userAgent: 'follow-up-scheduler' },
        );
        processed += 1;
      } catch (err) {
        this.logger.warn(`Due follow-up ${msg.id}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    return processed;
  }

  async ingestReply(dto: IngestReplyDto, provider = 'resend') {
    const from = dto.fromEmail.trim().toLowerCase();
    const existing = await this.prisma.inboundReply.findUnique({
      where: { provider_providerMessageId: { provider, providerMessageId: dto.providerMessageId } },
    });
    if (existing) return { reply: existing, deduplicated: true };

    const match = await this.matchLeadForReply(from, dto.inReplyTo);
    const classification = await classifyReplyWithAi(this.ai, this.config.resolveModel('ROUTINE'), dto.bodyText);

    const reply = await this.prisma.$transaction(async (tx) => {
      const row = await tx.inboundReply.create({
        data: {
          leadId: match.leadId,
          messageId: match.messageId,
          fromEmail: from,
          toEmail: dto.toEmail?.trim().toLowerCase() ?? null,
          subject: dto.subject ?? null,
          bodyText: dto.bodyText,
          provider,
          providerMessageId: dto.providerMessageId,
          matchStatus: match.status,
          classification: classification.classification,
          classificationReason: classification.reason,
          candidateLeadIds: match.candidates,
          rawSnapshot: { inReplyTo: dto.inReplyTo ?? null } as Prisma.InputJsonValue,
        },
      });

      if (match.leadId) {
        await tx.outreachEvent.create({
          data: {
            leadId: match.leadId,
            messageId: match.messageId,
            type: 'REPLY_RECEIVED',
            data: {
              replyId: row.id,
              classification: classification.classification,
              matchStatus: match.status,
            },
          },
        });

        if (classification.classification === 'UNSUBSCRIBE') {
          await tx.lead.update({
            where: { id: match.leadId },
            data: { doNotContact: true, optedOutAt: new Date(), stage: 'DO_NOT_CONTACT' },
          });
          await tx.outreachEvent.create({
            data: { leadId: match.leadId, messageId: match.messageId, type: 'OPT_OUT', data: { replyId: row.id } },
          });
          await this.cancelActiveFollowUps(tx, match.leadId, 'opt_out');
        } else {
          await this.cancelActiveFollowUps(tx, match.leadId, 'reply');
          const stagePatch = stageForClassification(classification.classification);
          if (stagePatch) {
            await tx.lead.update({ where: { id: match.leadId }, data: { stage: stagePatch } });
          }
        }
      }

      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'outreach.reply_ingested',
          entityType: 'inbound_reply',
          entityId: row.id,
          data: {
            classification: classification.classification,
            matchStatus: match.status,
            leadId: match.leadId,
          },
        },
        tx,
      );
      return row;
    });

    if (match.leadId) {
      this.events.emit({ type: 'lead.updated', leadId: match.leadId });
      if (classification.classification === 'POSITIVE') {
        await this.notifications.notifyCeo({
          type: 'POSITIVE_REPLY',
          title: 'Positive reply received',
          body: `From ${from}: ${(dto.subject ?? '').slice(0, 120)}`,
          link: `/leads/${match.leadId}`,
          dedupeKey: `positive-reply:${reply.id}`,
        });
      }
      if (classification.classification === 'DEMO_REQUEST') {
        await this.notifications.notifyCeo({
          type: 'DEMO_REQUESTED',
          title: 'Demo requested',
          body: `From ${from}`,
          link: `/leads/${match.leadId}`,
          dedupeKey: `demo-reply:${reply.id}`,
        });
      }
    }

    return { reply, deduplicated: false };
  }

  async confirmDeal(leadId: string, dto: ConfirmDealDto, user: AuthUser, ctx: RequestContext) {
    this.assertCeoOrAdmin(user);
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, include: { project: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.project) throw new BadRequestException('A project already exists for this lead.');
    if (!['DEMO_COMPLETED', 'NEGOTIATION', 'INTERESTED', 'DEMO_REQUESTED'].includes(lead.stage) && lead.stage !== 'WON') {
      // Allow confirm from late stages; block from early cold stages.
      if (['NEW', 'QUALIFIED', 'DRAFT_READY', 'AWAITING_APPROVAL', 'CONTACTED', 'LOST', 'DO_NOT_CONTACT'].includes(lead.stage)) {
        throw new BadRequestException(`Cannot confirm a deal from stage ${lead.stage}. Move the lead to negotiation/demo completed first.`);
      }
    }
    if (!dto.scope.trim()) throw new BadRequestException('Project scope confirmation is required.');

    const project = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          stage: 'WON',
          wonAt: new Date(),
          dealValue: new Prisma.Decimal(dto.dealValue),
          currency: (dto.currency ?? 'USD').toUpperCase().slice(0, 8),
        },
      });
      const p = await tx.project.create({
        data: {
          leadId,
          name: dto.projectName?.trim() || `Project — ${lead.name}`.slice(0, 200),
          description: dto.scope.trim(),
          status: 'PLANNING',
          dealValue: new Prisma.Decimal(dto.dealValue),
          currency: (dto.currency ?? 'USD').toUpperCase().slice(0, 8),
          confirmedById: user.id,
          confirmedAt: new Date(),
        },
      });
      await tx.outreachEvent.create({
        data: {
          leadId,
          type: 'NOTE',
          data: { kind: 'deal_confirmed', projectId: p.id, dealValue: dto.dealValue },
        },
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'deal.confirm',
          entityType: 'project',
          entityId: p.id,
          data: { leadId, dealValue: dto.dealValue },
          ctx,
        },
        tx,
      );
      return p;
    });

    this.events.emit({ type: 'lead.updated', leadId });
    return { project, leadId };
  }

  async getReviewBundle(messageId: string) {
    const message = await this.prisma.outreachMessage.findUnique({
      where: { id: messageId },
      include: {
        lead: {
          include: {
            sources: { include: { source: true }, orderBy: { discoveredAt: 'desc' }, take: 3 },
          },
        },
      },
    });
    if (!message) throw new NotFoundException('Message not found');
    const approval = message.approvalId
      ? await this.prisma.approval.findUnique({ where: { id: message.approvalId } })
      : await this.prisma.approval.findFirst({
          where: { entityType: 'outreach_message', entityId: messageId },
          orderBy: { createdAt: 'desc' },
        });
    return {
      message: {
        id: message.id,
        subject: message.subject,
        body: message.body,
        rationale: message.rationale,
        status: message.status,
        channel: message.channel,
        recipientEmail: message.recipientEmail,
        isFollowUp: message.isFollowUp,
        scheduledFor: message.scheduledFor,
        sentAt: message.sentAt,
        provider: message.provider,
        providerMessageId: message.providerMessageId,
        deliveryStatus: message.deliveryStatus,
        lastProviderError: message.lastProviderError,
      },
      lead: {
        id: message.lead.id,
        name: message.lead.name,
        contactName: message.lead.contactName,
        contactEmail: message.lead.contactEmail,
        stage: message.lead.stage,
        requirements: message.lead.requirements,
        doNotContact: message.lead.doNotContact,
        outreachPausedAt: message.lead.outreachPausedAt,
        sources: message.lead.sources.map((s) => ({
          url: s.url,
          sourceName: s.source.name,
          accessMethod: s.accessMethod,
        })),
      },
      approval: approval
        ? {
            id: approval.id,
            status: approval.status,
            summary: approval.summary,
            decidedAt: approval.decidedAt,
            decisionNote: approval.decisionNote,
          }
        : null,
      emailProvider: this.email.status(),
    };
  }

  private async matchLeadForReply(fromEmail: string, inReplyTo?: string | null) {
    if (inReplyTo) {
      const byProvider = await this.prisma.outreachMessage.findFirst({
        where: { providerMessageId: inReplyTo },
        select: { id: true, leadId: true },
      });
      if (byProvider) return { status: 'MATCHED' as const, leadId: byProvider.leadId, messageId: byProvider.id, candidates: [] as string[] };
    }

    const leads = await this.prisma.lead.findMany({
      where: { contactEmail: { equals: fromEmail, mode: 'insensitive' } },
      select: { id: true },
      take: 5,
    });
    if (leads.length === 1) {
      const lastSent = await this.prisma.outreachMessage.findFirst({
        where: { leadId: leads[0]!.id, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        select: { id: true },
      });
      return { status: 'MATCHED' as const, leadId: leads[0]!.id, messageId: lastSent?.id ?? null, candidates: [] as string[] };
    }
    if (leads.length > 1) {
      return {
        status: 'AMBIGUOUS' as const,
        leadId: null,
        messageId: null,
        candidates: leads.map((l) => l.id),
      };
    }
    return { status: 'UNMATCHED' as const, leadId: null, messageId: null, candidates: [] as string[] };
  }

  private async cancelActiveFollowUps(tx: Prisma.TransactionClient, leadId: string, reason: string): Promise<number> {
    const active = await tx.outreachMessage.findMany({
      where: { leadId, status: { in: ACTIVE_FOLLOW_UP } },
      select: { id: true, isFollowUp: true },
    });
    const followUpIds = active.filter((m) => m.isFollowUp).map((m) => m.id);
    const allIds = active.map((m) => m.id);
    if (followUpIds.length) {
      await tx.outreachMessage.updateMany({
        where: { id: { in: followUpIds } },
        data: { status: 'CANCELLED' },
      });
      await tx.outreachEvent.create({
        data: { leadId, type: 'NOTE', data: { kind: 'follow_ups_cancelled', reason, count: followUpIds.length } },
      });
    }
    if (allIds.length) {
      await tx.approval.updateMany({
        where: {
          actionType: 'SEND_EXTERNAL_MESSAGE',
          status: 'PENDING',
          entityType: 'outreach_message',
          entityId: { in: allIds },
        },
        data: { status: 'CANCELLED', decidedAt: new Date(), decisionNote: `Cancelled: ${reason}` },
      });
    }
    return followUpIds.length;
  }

  private async loadMessage(leadId: string, messageId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    const message = await this.prisma.outreachMessage.findFirst({
      where: { id: messageId, leadId },
      include: { parentMessage: true },
    });
    if (!message) throw new NotFoundException('Outreach message not found');
    return { lead, message };
  }

  private assertCanOutreach(lead: { doNotContact: boolean; optedOutAt: Date | null }) {
    if (lead.doNotContact || lead.optedOutAt) {
      throw new BadRequestException('Cannot send outreach to a do-not-contact / opted-out lead.');
    }
  }

  private assertCeoOrAdmin(user: AuthUser) {
    if (user.role !== 'CEO' && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the CEO (or admin) may authorize external outreach.');
    }
  }
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function appendOptOutFooter(body: string): string {
  if (/unsubscribe|opt-out|opt out/i.test(body)) return body;
  return `${body.trim()}\n\n---\nIf you prefer not to hear from us, reply with “unsubscribe”.`;
}

function stageForClassification(c: string): 'REPLIED' | 'INTERESTED' | 'DEMO_REQUESTED' | null {
  if (c === 'DEMO_REQUEST') return 'DEMO_REQUESTED';
  if (c === 'POSITIVE') return 'INTERESTED';
  if (c === 'NEUTRAL' || c === 'NEGATIVE' || c === 'NEEDS_REVIEW') return 'REPLIED';
  return null;
}
