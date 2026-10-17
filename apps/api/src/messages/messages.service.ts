import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import { AiCredentialsError, AiProviderError } from '../ai/ai.errors';
import { PERMISSIONS } from '../agents/registry';
import type { AuthUser } from '../common/auth.decorators';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PostTeamMessageDto } from './messages.dto';

const teamReplySchema = z.object({
  reply: z.string().min(1).max(4000),
});

const threadInclude = {
  agent: { select: { id: true, key: true, name: true, kind: true, role: true, isEnabled: true } },
  messages: {
    orderBy: { createdAt: 'asc' as const },
    take: 200,
    include: {
      user: { select: { id: true, name: true, role: true } },
      agent: { select: { id: true, key: true, name: true, kind: true } },
    },
  },
};

@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Grant message_ceo to existing agents (seed only creates missing rows). */
  async onModuleInit() {
    try {
      const agents = await this.prisma.agentDefinition.findMany({
        select: { id: true, tools: true, permissions: { select: { permission: true } } },
      });
      for (const agent of agents) {
        if (!agent.tools.includes('message_ceo')) {
          await this.prisma.agentDefinition.update({
            where: { id: agent.id },
            data: { tools: [...agent.tools, 'message_ceo'] },
          });
        }
        if (!agent.permissions.some((p) => p.permission === 'messages.send')) {
          await this.prisma.agentPermission.create({
            data: {
              agentId: agent.id,
              permission: 'messages.send',
              requiresApproval: PERMISSIONS['messages.send'].approvalLocked,
            },
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Could not sync messaging tools (tables may be pending migrate): ${err instanceof Error ? err.message : err}`);
    }
  }

  listAgents() {
    return this.prisma.agentDefinition.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        kind: true,
        role: true,
        departmentId: true,
        department: { select: { key: true, name: true } },
      },
    });
  }

  async listThreads(userId: string) {
    const threads = await this.prisma.teamThread.findMany({
      where: { createdByUserId: userId },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        agent: { select: { id: true, key: true, name: true, kind: true, role: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, body: true, authorKind: true, createdAt: true },
        },
      },
    });
    return threads.map((t) => ({
      id: t.id,
      subject: t.subject,
      lastMessageAt: t.lastMessageAt,
      createdAt: t.createdAt,
      agent: t.agent,
      lastMessage: t.messages[0] ?? null,
    }));
  }

  async getThread(userId: string, threadId: string) {
    const thread = await this.prisma.teamThread.findFirst({
      where: { id: threadId, createdByUserId: userId },
      include: threadInclude,
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return thread;
  }

  /** CEO posts a message; the teammate AI replies in the same request. */
  async postAsCeo(user: AuthUser, dto: PostTeamMessageDto, threadId?: string) {
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Message body is required.');

    let thread =
      threadId != null
        ? await this.prisma.teamThread.findFirst({
            where: { id: threadId, createdByUserId: user.id },
            include: { agent: true },
          })
        : null;

    if (threadId && !thread) throw new NotFoundException('Thread not found');

    if (!thread) {
      if (!dto.agentId) throw new BadRequestException('Pick a teammate (agentId) to start a conversation.');
      const agent = await this.prisma.agentDefinition.findFirst({
        where: { id: dto.agentId, isEnabled: true },
      });
      if (!agent) throw new BadRequestException('That teammate is missing or disabled.');

      thread = await this.prisma.teamThread.upsert({
        where: { agentId_createdByUserId: { agentId: agent.id, createdByUserId: user.id } },
        create: {
          agentId: agent.id,
          createdByUserId: user.id,
          subject: (dto.subject ?? '').trim().slice(0, 200),
        },
        update: {
          subject: dto.subject?.trim() ? dto.subject.trim().slice(0, 200) : undefined,
        },
        include: { agent: true },
      });
    }

    await this.prisma.teamMessage.create({
      data: {
        threadId: thread.id,
        authorKind: 'USER',
        userId: user.id,
        body: body.slice(0, 4000),
      },
    });
    await this.prisma.teamThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date() },
    });
    this.events.emit({ type: 'message.created', threadId: thread.id, agentId: thread.agentId });

    try {
      await this.generateAgentReply(thread.id, thread.agentId);
    } catch (err) {
      this.logger.warn(`Agent reply failed for thread ${thread.id}: ${err instanceof Error ? err.message : err}`);
      const hint = publicReplyFailureHint(err);
      await this.appendAgentMessage(thread.id, thread.agentId, hint);
    }

    return this.getThread(user.id, thread.id);
  }

  /**
   * Agent posts an update into its thread with the CEO (creates the thread if needed).
   * Used after task completion and by the message_ceo tool.
   */
  async postFromAgent(opts: {
    agentId: string;
    body: string;
    taskId?: string | null;
    notify?: boolean;
  }) {
    const body = opts.body.trim().slice(0, 4000);
    if (!body) throw new BadRequestException('Message body is required.');

    const agent = await this.prisma.agentDefinition.findUnique({ where: { id: opts.agentId } });
    if (!agent) throw new NotFoundException('Agent not found');

    const ceos = await this.prisma.user.findMany({
      where: { role: 'CEO', isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 1,
    });
    const ceo = ceos[0];
    if (!ceo) throw new BadRequestException('No active CEO to message.');

    const thread = await this.prisma.teamThread.upsert({
      where: { agentId_createdByUserId: { agentId: agent.id, createdByUserId: ceo.id } },
      create: {
        agentId: agent.id,
        createdByUserId: ceo.id,
        subject: `Updates from ${agent.name}`,
      },
      update: {},
    });

    const msg = await this.appendAgentMessage(thread.id, agent.id, body, opts.taskId ?? null);

    if (opts.notify !== false) {
      await this.notifications.notifyCeo({
        type: 'SYSTEM',
        title: `${agent.name} messaged you`,
        body: body.slice(0, 240),
        link: `/messages/${thread.id}`,
        dedupeKey: `team-msg:${msg.id}`,
      });
    }

    return { threadId: thread.id, messageId: msg.id };
  }

  private async appendAgentMessage(threadId: string, agentId: string, body: string, taskId?: string | null) {
    const msg = await this.prisma.teamMessage.create({
      data: {
        threadId,
        authorKind: 'AGENT',
        agentId,
        body: body.slice(0, 4000),
        taskId: taskId ?? null,
      },
    });
    await this.prisma.teamThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
    });
    this.events.emit({ type: 'message.created', threadId, agentId });
    return msg;
  }

  private async generateAgentReply(threadId: string, agentId: string) {
    const agent = await this.prisma.agentDefinition.findUniqueOrThrow({ where: { id: agentId } });
    const history = await this.prisma.teamMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      take: 40,
      include: {
        user: { select: { name: true } },
        agent: { select: { name: true } },
      },
    });

    const transcript = history
      .map((m) => {
        const who = m.authorKind === 'USER' ? `CEO (${m.user?.name ?? 'Boss'})` : agent.name;
        return `${who}: ${m.body}`;
      })
      .join('\n\n');

    const completion = await this.ai.completeStructured({
      tier: agent.modelTier,
      modelOverride: agent.modelOverride,
      maxOutputTokens: Math.min(agent.maxOutputTokens, 1200),
      schema: teamReplySchema,
      schemaName: 'team_message_reply',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: [
            `You are ${agent.name}, ${agent.role} at an AI automation company. The human is the CEO (your boss).`,
            'Reply in first person as this teammate — short, practical, honest. Do not invent leads, prices, metrics, or completed work.',
            'If the CEO asks you to do work, acknowledge and explain what you would need (a Task with Run with AI) rather than pretending it is already done.',
            '',
            'Your standing instructions:',
            agent.instructions,
            '',
            'Reporting responsibilities:',
            agent.reportingResponsibilities,
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Conversation so far:\n\n${transcript}\n\nWrite your next reply to the CEO.`,
        },
      ],
    });

    await this.appendAgentMessage(threadId, agentId, completion.data.reply);
  }
}

function publicReplyFailureHint(err: unknown): string {
  if (err instanceof AiCredentialsError) {
    return 'AI is not configured, so I cannot reply yet. Check Settings.';
  }
  if (err instanceof ServiceUnavailableException) {
    return 'I could not reach the AI provider just now. Try again in a moment.';
  }
  if (err instanceof AiProviderError) {
    const msg = err.message.replace(/\s+/g, ' ').trim().slice(0, 280);
    if (/Could not reach|network connectivity/i.test(msg)) {
      return 'I could not reach the AI provider just now. Try again in a moment.';
    }
    return `AI provider error: ${msg}`;
  }
  return 'I hit an error generating a reply. Please try again.';
}
