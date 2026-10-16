import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ApprovalStatus } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { EventsService } from '../events/events.service';
import { MarketingService } from '../marketing/marketing.service';
import { OutreachService } from '../outreach/outreach.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DecideApprovalDto, ListApprovalsQueryDto } from '../outreach/outreach.dto';

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outreach: OutreachService,
    private readonly marketing: MarketingService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async list(q: ListApprovalsQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const status = (q.status?.toUpperCase() || 'PENDING') as ApprovalStatus | 'ALL';
    const where: Prisma.ApprovalWhereInput =
      status === 'ALL' ? {} : { status: status as ApprovalStatus };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.approval.count({ where }),
      this.prisma.approval.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          requestedByAgent: { select: { id: true, key: true, name: true } },
          decidedBy: { select: { id: true, name: true } },
          task: { select: { id: true, title: true } },
        },
      }),
    ]);

    return {
      items: items.map((a) => this.toView(a)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      emailProvider: this.outreach.providerStatus(),
    };
  }

  async get(id: string) {
    const a = await this.prisma.approval.findUnique({
      where: { id },
      include: {
        requestedByAgent: { select: { id: true, key: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } },
      },
    });
    if (!a) throw new NotFoundException('Approval not found');
    const view = this.toView(a);
    let review = null;
    if (a.actionType === 'SEND_EXTERNAL_MESSAGE' && a.entityId) {
      try {
        review = await this.outreach.getReviewBundle(a.entityId);
      } catch {
        review = null;
      }
    }
    return { ...view, review };
  }

  async decide(id: string, dto: DecideApprovalDto, user: AuthUser, ctx: RequestContext) {
    if (user.role !== 'CEO' && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the CEO (or admin) may decide approvals.');
    }
    if (dto.decision !== 'APPROVE' && dto.decision !== 'REJECT') {
      throw new BadRequestException('decision must be APPROVE or REJECT');
    }

    const approval = await this.prisma.approval.findUnique({ where: { id } });
    if (!approval) throw new NotFoundException('Approval not found');
    if (approval.status !== 'PENDING') throw new BadRequestException(`Approval is already ${approval.status}.`);

    const nextStatus: ApprovalStatus = dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    await this.prisma.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id },
        data: {
          status: nextStatus,
          decidedById: user.id,
          decidedAt: new Date(),
          decisionNote: dto.note?.trim() || null,
        },
      });

      if (approval.entityType === 'outreach_message' && approval.entityId) {
        if (nextStatus === 'REJECTED') {
          await tx.outreachMessage.updateMany({
            where: { id: approval.entityId, status: 'AWAITING_APPROVAL' },
            data: { status: 'DRAFT' },
          });
          const msg = await tx.outreachMessage.findUnique({ where: { id: approval.entityId } });
          if (msg) {
            await tx.outreachEvent.create({
              data: { leadId: msg.leadId, messageId: msg.id, type: 'REJECTED', data: { approvalId: id } },
            });
          }
        } else {
          await tx.outreachMessage.updateMany({
            where: { id: approval.entityId },
            data: { status: 'APPROVED' },
          });
          const msg = await tx.outreachMessage.findUnique({ where: { id: approval.entityId } });
          if (msg) {
            await tx.outreachEvent.create({
              data: { leadId: msg.leadId, messageId: msg.id, type: 'APPROVED', data: { approvalId: id } },
            });
          }
        }
      }

      if (approval.entityType === 'content_item' && approval.entityId && nextStatus === 'REJECTED') {
        await tx.contentItem.updateMany({
          where: { id: approval.entityId, status: 'AWAITING_APPROVAL' },
          data: { status: 'DRAFTING' },
        });
      }
      if (approval.entityType === 'campaign' && approval.entityId && nextStatus === 'REJECTED') {
        await tx.campaign.updateMany({
          where: { id: approval.entityId, status: 'AWAITING_APPROVAL' },
          data: { status: 'PROPOSED' },
        });
      }

      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: nextStatus === 'APPROVED' ? 'approval.approved' : 'approval.rejected',
          entityType: 'approval',
          entityId: id,
          data: { actionType: approval.actionType, note: dto.note ?? null },
          ctx,
        },
        tx,
      );
    });

    this.events.emit({ type: 'approval.updated', approvalId: id, status: nextStatus });

    let sendResult: unknown = null;
    let marketingResult: unknown = null;
    if (nextStatus === 'APPROVED' && approval.actionType === 'SEND_EXTERNAL_MESSAGE') {
      sendResult = await this.outreach.executeApprovedSend(id, user, ctx);
    }
    if (nextStatus === 'APPROVED' && approval.actionType === 'PUBLISH_CONTENT') {
      marketingResult = await this.marketing.executePublishContent(id, user, ctx);
    }
    if (nextStatus === 'APPROVED' && approval.actionType === 'LAUNCH_PAID_CAMPAIGN') {
      marketingResult = await this.marketing.executeLaunchCampaign(id, user, ctx);
    }

    return { approval: await this.get(id), sendResult, marketingResult };
  }

  private toView(a: {
    id: string;
    actionType: string;
    status: string;
    entityType: string;
    entityId: string | null;
    summary: string;
    payload: unknown;
    decidedAt: Date | null;
    decisionNote: string | null;
    createdAt: Date;
    expiresAt: Date | null;
    requestedByAgent: { id: string; key: string; name: string } | null;
    decidedBy: { id: string; name: string } | null;
    task: { id: string; title: string } | null;
  }) {
    return {
      id: a.id,
      actionType: a.actionType,
      status: a.status,
      entityType: a.entityType,
      entityId: a.entityId,
      summary: a.summary,
      payload: a.payload,
      decidedAt: a.decidedAt,
      decisionNote: a.decisionNote,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      requestedByAgent: a.requestedByAgent,
      decidedBy: a.decidedBy,
      task: a.task,
    };
  }
}
