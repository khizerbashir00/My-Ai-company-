import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ApprovalActionType, TaskPriority } from '../generated/prisma/client';
import { CURRENT_EXECUTION_PHASE } from '../ai/ai.types';
import type { WorkerResult } from '../ai/schemas';
import { isToolName, PERMISSIONS, TOOLS, type ToolName } from '../agents/registry';
import { PrismaService } from '../prisma/prisma.service';
import { MarketingService } from '../marketing/marketing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutreachService } from '../outreach/outreach.service';
import { SourcesService } from '../sources/sources.service';
import { TasksService, type TaskActor } from '../tasks/tasks.service';

export interface ToolExecutionContext {
  runId: string;
  taskId: string;
  agentId: string;
  agentKey: string;
  agentTools: string[];
  agentPermissions: string[];
  createdByUserId: string;
  parentTaskId: string;
}

export interface ToolExecutionResult {
  status: 'SUCCEEDED' | 'DENIED' | 'FAILED' | 'AWAITING_APPROVAL';
  result?: Record<string, unknown>;
  errorMessage?: string;
  approvalId?: string;
  createdTaskId?: string;
  submitted?: boolean;
  submitOutcome?: WorkerResult['outcome'];
}

const APPROVAL_ACTION_FOR_PERMISSION: Partial<Record<string, ApprovalActionType>> = {
  'outreach.send': 'SEND_EXTERNAL_MESSAGE',
  'content.publish': 'PUBLISH_CONTENT',
  'campaigns.launch_paid': 'LAUNCH_PAID_CAMPAIGN',
  'files.share_sensitive': 'SHARE_SENSITIVE_FILE',
  'records.bulk_delete': 'BULK_DELETE',
  'customer.commit': 'CUSTOMER_COMMITMENT',
  'deals.confirm': 'CONFIRM_DEAL',
};

@Injectable()
export class ToolExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly sources: SourcesService,
    private readonly outreach: OutreachService,
    private readonly notifications: NotificationsService,
    private readonly marketing: MarketingService,
  ) {}

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const call = await this.prisma.toolCall.create({
      data: {
        agentRunId: ctx.runId,
        toolName,
        arguments: args as Prisma.InputJsonValue,
        status: 'REQUESTED',
      },
    });

    // Registry / permission / phase checks (approval-locked tools short-circuit to an approval request).
    const denial = this.authorize(toolName, ctx, { allowApprovalLockedBeyondPhase: true });
    if (denial) {
      await this.prisma.toolCall.update({
        where: { id: call.id },
        data: { status: 'DENIED', errorMessage: denial, finishedAt: new Date() },
      });
      return { status: 'DENIED', errorMessage: denial };
    }

    const tool = TOOLS[toolName as ToolName];
    const perm = PERMISSIONS[tool.requires];

    // These tools create typed approvals themselves — do not double-wrap.
    const selfManagedApproval =
      toolName === 'request_send_outreach' ||
      toolName === 'request_publish_content' ||
      toolName === 'request_launch_paid_campaign';

    if (perm.approvalLocked && !selfManagedApproval) {
      const approval = await this.requestApproval(toolName, args, ctx, tool.requires);
      await this.prisma.toolCall.update({
        where: { id: call.id },
        data: {
          status: 'DENIED',
          errorMessage: 'External side effects require CEO approval.',
          result: { approvalId: approval.id } as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      return {
        status: 'AWAITING_APPROVAL',
        approvalId: approval.id,
        errorMessage: 'External side effects require CEO approval.',
        result: { approvalId: approval.id },
      };
    }

    try {
      const outcome = await this.dispatch(toolName as ToolName, args, ctx);
      const status: ToolExecutionResult['status'] =
        outcome.status === 'AWAITING_APPROVAL' ? 'AWAITING_APPROVAL' : 'SUCCEEDED';
      await this.prisma.toolCall.update({
        where: { id: call.id },
        data: {
          status: 'SUCCEEDED',
          result: (outcome.result ?? {}) as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      return { ...outcome, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      await this.prisma.toolCall.update({
        where: { id: call.id },
        data: { status: 'FAILED', errorMessage: message.slice(0, 2000), finishedAt: new Date() },
      });
      return { status: 'FAILED', errorMessage: message };
    }
  }

  /** Pure authorization check — used by unit tests and execute(). */
  authorize(
    toolName: string,
    ctx: Pick<ToolExecutionContext, 'agentTools' | 'agentPermissions'>,
    opts?: { allowApprovalLockedBeyondPhase?: boolean },
  ): string | null {
    if (!isToolName(toolName)) {
      return `Unknown tool "${toolName}". Only registry tools are allowed.`;
    }
    const tool = TOOLS[toolName];
    const perm = PERMISSIONS[tool.requires];
    const skipPhase = opts?.allowApprovalLockedBeyondPhase && perm.approvalLocked;
    if (!skipPhase && tool.availableFromPhase > CURRENT_EXECUTION_PHASE) {
      return `Tool "${toolName}" is not available yet (requires phase ${tool.availableFromPhase}; current phase is ${CURRENT_EXECUTION_PHASE}).`;
    }
    if (!ctx.agentTools.includes(toolName)) {
      return `Agent is not configured with tool "${toolName}".`;
    }
    if (!ctx.agentPermissions.includes(tool.requires)) {
      return `Agent lacks permission "${tool.requires}" required by "${toolName}".`;
    }
    return null;
  }

  private async dispatch(
    toolName: ToolName,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Partial<ToolExecutionResult>> {
    if (toolName === 'delegate_task') {
      return this.delegateTask(args, ctx);
    }
    if (toolName === 'submit_result') {
      return this.submitResult(args, ctx);
    }
    if (toolName === 'search_lead_sources') {
      return this.searchLeadSources(args);
    }
    if (toolName === 'request_send_outreach') {
      return this.requestSendOutreach(args, ctx);
    }
    if (toolName === 'schedule_follow_up') {
      return this.scheduleFollowUpTool(args, ctx);
    }
    if (toolName === 'notify_ceo') {
      return this.notifyCeoTool(args);
    }
    if (toolName === 'create_campaign_proposal') {
      const campaign = await this.marketing.createCampaignFromTool(args);
      return { result: { campaignId: campaign.id, status: campaign.status, name: campaign.name } };
    }
    if (toolName === 'create_content_draft') {
      const item = await this.marketing.createContentDraftFromTool(args, ctx.createdByUserId);
      return { result: { contentItemId: item.id, version: item.currentVersion, title: item.title } };
    }
    if (toolName === 'request_publish_content') {
      const contentItemId = stringArg(args, 'contentItemId');
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.createdByUserId } });
      const result = await this.marketing.requestPublishContent(
        contentItemId,
        { id: user.id, email: user.email, name: user.name, role: user.role },
        { ip: null, userAgent: `agent:${ctx.agentKey}` },
        { taskId: ctx.taskId, requestedByAgentId: ctx.agentId },
      );
      return { result: result as unknown as Record<string, unknown>, approvalId: result.approvalId, status: 'AWAITING_APPROVAL' };
    }
    if (toolName === 'request_launch_paid_campaign') {
      const campaignId = stringArg(args, 'campaignId');
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.createdByUserId } });
      const result = await this.marketing.requestLaunchCampaign(
        campaignId,
        { id: user.id, email: user.email, name: user.name, role: user.role },
        { ip: null, userAgent: `agent:${ctx.agentKey}` },
        { taskId: ctx.taskId, requestedByAgentId: ctx.agentId },
      );
      return { result: result as unknown as Record<string, unknown>, approvalId: result.approvalId, status: 'AWAITING_APPROVAL' };
    }
    if (toolName === 'read_analytics') {
      const summary = await this.marketing.readAnalyticsSummary();
      return { result: summary as unknown as Record<string, unknown> };
    }
    if (toolName === 'generate_report') {
      const period = args.period === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.createdByUserId } });
      const report = await this.marketing.generateReport(
        { period, asOf: typeof args.asOf === 'string' ? args.asOf : undefined },
        { id: user.id, email: user.email, name: user.name, role: user.role },
        { ip: null, userAgent: `agent:${ctx.agentKey}` },
      );
      return { result: { reportId: report.id, title: report.title, period: report.period } };
    }
    if (toolName === 'fetch_public_page') {
      return this.fetchPublicPage(args);
    }
    throw new BadRequestException(`No executor implemented for tool "${toolName}".`);
  }

  /** Public page fetch for research — returns URL + excerpt only; never invents facts. */
  private async fetchPublicPage(args: Record<string, unknown>): Promise<Partial<ToolExecutionResult>> {
    const url = stringArg(args, 'url');
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('url must be http(s).');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'ai-company-hq/0.1 (research; +https://localhost)' },
      });
      if (!res.ok) {
        return {
          result: {
            url,
            status: res.status,
            kind: 'VERIFIED',
            title: null,
            excerpt: null,
            note: `Upstream returned HTTP ${res.status}. Do not invent page contents.`,
            researchedAt: new Date().toISOString(),
          },
        };
      }
      const text = await res.text();
      const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? null;
      const excerpt = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1500);
      return {
        result: {
          url,
          status: res.status,
          kind: 'VERIFIED',
          title,
          excerpt: excerpt || null,
          note: 'Excerpt from fetched HTML only. Treat as evidence for VERIFIED findings with this URL. Do not invent prices or metrics.',
          researchedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        result: {
          url,
          status: null,
          kind: 'SUGGESTION',
          title: null,
          excerpt: null,
          note: `Fetch failed: ${err instanceof Error ? err.message : 'error'}. Mark related claims as SUGGESTION/ESTIMATE, not VERIFIED.`,
          researchedAt: new Date().toISOString(),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchLeadSources(args: Record<string, unknown>): Promise<Partial<ToolExecutionResult>> {
    const sourceKey = typeof args.sourceKey === 'string' ? args.sourceKey : typeof args.source === 'string' ? args.source : undefined;
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined;
    const result = await this.sources.searchViaTool({ sourceKey, maxResults });
    return { result: result as unknown as Record<string, unknown> };
  }

  private async requestSendOutreach(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Partial<ToolExecutionResult>> {
    const leadId = stringArg(args, 'leadId');
    const messageId = stringArg(args, 'messageId');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.createdByUserId } });
    // Still creates a PENDING approval — never sends without CEO decide.
    const result = await this.outreach.requestSend(
      leadId,
      messageId,
      { recipientEmail: typeof args.recipientEmail === 'string' ? args.recipientEmail : undefined },
      { id: user.id, email: user.email, name: user.name, role: user.role },
      { ip: null, userAgent: `agent:${ctx.agentKey}` },
    );
    return { result: result as unknown as Record<string, unknown>, approvalId: result.approvalId, status: 'AWAITING_APPROVAL' };
  }

  private async scheduleFollowUpTool(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Partial<ToolExecutionResult>> {
    const leadId = stringArg(args, 'leadId');
    const scheduledFor = stringArg(args, 'scheduledFor');
    const body = stringArg(args, 'body');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.createdByUserId } });
    const result = await this.outreach.scheduleFollowUp(
      leadId,
      {
        scheduledFor,
        body,
        subject: typeof args.subject === 'string' ? args.subject : undefined,
        rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
        parentMessageId: typeof args.parentMessageId === 'string' ? args.parentMessageId : undefined,
      },
      { id: user.id, email: user.email, name: user.name, role: user.role },
      { ip: null, userAgent: `agent:${ctx.agentKey}` },
    );
    return { result: { messageId: result.message.id, deduplicated: result.deduplicated, status: result.message.status } };
  }

  private async notifyCeoTool(args: Record<string, unknown>): Promise<Partial<ToolExecutionResult>> {
    const title = stringArg(args, 'title');
    const body = typeof args.body === 'string' ? args.body : '';
    const dedupeKey = typeof args.dedupeKey === 'string' && args.dedupeKey.trim() ? args.dedupeKey.trim() : `notify:${title.slice(0, 80)}`;
    const created = await this.notifications.notifyCeo({
      type: 'SYSTEM',
      title,
      body,
      link: typeof args.link === 'string' ? args.link : null,
      dedupeKey,
    });
    return { result: { created } };
  }

  private async delegateTask(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Partial<ToolExecutionResult>> {
    const title = stringArg(args, 'title');
    const description = typeof args.description === 'string' ? args.description : '';
    const assigneeKey = stringArg(args, 'assigneeAgentKey');
    const stepKey = typeof args.stepKey === 'string' && args.stepKey.trim() ? args.stepKey.trim() : title.slice(0, 60);
    const priority = parsePriority(args.priority);

    const assignee = await this.prisma.agentDefinition.findUnique({
      where: { key: assigneeKey },
      select: { id: true, key: true, name: true, parentId: true, isEnabled: true, departmentId: true },
    });
    if (!assignee) throw new BadRequestException(`Unknown assignee agent key "${assigneeKey}".`);
    if (!assignee.isEnabled) throw new BadRequestException(`${assignee.name} is disabled.`);

    // Managers may only delegate to their own children; GM may delegate to managers.
    const caller = await this.prisma.agentDefinition.findUniqueOrThrow({
      where: { id: ctx.agentId },
      select: { id: true, kind: true },
    });
    if (caller.kind === 'MANAGER' && assignee.parentId !== caller.id) {
      throw new BadRequestException(`${assignee.name} is not managed by this agent.`);
    }
    if (caller.kind === 'GENERAL_MANAGER') {
      const ok = await this.prisma.agentDefinition.findFirst({
        where: { id: assignee.id, parentId: caller.id },
        select: { id: true },
      });
      if (!ok) throw new BadRequestException(`${assignee.name} is not a direct report of the General Manager.`);
    }
    if (caller.kind === 'WORKER') {
      throw new BadRequestException('Workers cannot delegate tasks.');
    }

    const actor: TaskActor = { type: 'AGENT', agentId: ctx.agentId, createdByUserId: ctx.createdByUserId };
    const { task, deduplicated } = await this.tasks.createAs(
      {
        title,
        description,
        assignedAgentId: assignee.id,
        parentTaskId: ctx.parentTaskId,
        priority,
        idempotencyKey: `delegate:${ctx.parentTaskId}:${stepKey}`,
        input: { delegatedBy: ctx.agentKey, stepKey, sourceRunId: ctx.runId },
      },
      actor,
    );

    return {
      result: { taskId: task.id, deduplicated, assigneeKey: assignee.key },
      createdTaskId: task.id,
    };
  }

  private async submitResult(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Partial<ToolExecutionResult>> {
    const result = args.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new BadRequestException('submit_result requires a structured result object.');
    }
    const outcome = (result as WorkerResult).outcome;
    if (outcome !== 'completed' && outcome !== 'blocked' && outcome !== 'needs_review') {
      throw new BadRequestException('submit_result.result.outcome must be completed, blocked, or needs_review.');
    }
    const findings = Array.isArray((result as WorkerResult).findings) ? (result as WorkerResult).findings : [];
    if (findings.some((f) => f?.invented === true)) {
      throw new BadRequestException('submit_result rejected: findings marked invented=true are not allowed.');
    }

    await this.tasks.setOutput(ctx.taskId, result as Record<string, unknown>);
    return { result: { submitted: true, outcome }, submitted: true, submitOutcome: outcome };
  }

  private async requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
    permission: string,
  ) {
    const actionType = APPROVAL_ACTION_FOR_PERMISSION[permission] ?? 'CUSTOMER_COMMITMENT';
    return this.prisma.approval.create({
      data: {
        actionType,
        status: 'PENDING',
        entityType: 'tool_call',
        entityId: ctx.runId,
        summary: `Agent requested "${toolName}" which requires approval (${permission}).`,
        payload: { toolName, arguments: args, agentId: ctx.agentId, taskId: ctx.taskId } as Prisma.InputJsonValue,
        requestedByAgentId: ctx.agentId,
        taskId: ctx.taskId,
      },
    });
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestException(`Missing or invalid "${key}" for tool call.`);
  return v.trim();
}

function parsePriority(v: unknown): TaskPriority {
  if (v === 'LOW' || v === 'NORMAL' || v === 'HIGH' || v === 'URGENT') return v;
  return 'NORMAL';
}
