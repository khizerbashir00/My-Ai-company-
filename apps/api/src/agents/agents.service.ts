import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { ACTIVE_STATUSES } from '../tasks/task-state-machine';
import { ListAgentsQueryDto, SetPermissionsDto, UpdateAgentDto } from './agents.dto';
import { PERMISSIONS, TOOLS, isPermissionKey, isToolName, toolsMissingPermissions } from './registry';

const agentInclude = {
  department: { select: { id: true, key: true, name: true } },
  parent: { select: { id: true, key: true, name: true, kind: true } },
  children: { orderBy: { sortOrder: 'asc' }, select: { id: true, key: true, name: true, kind: true, isEnabled: true } },
  permissions: { orderBy: { permission: 'asc' }, select: { permission: true, requiresApproval: true } },
} satisfies Prisma.AgentDefinitionInclude;

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  registry() {
    return {
      tools: Object.values(TOOLS),
      permissions: Object.values(PERMISSIONS),
    };
  }

  async list(q: ListAgentsQueryDto) {
    const agents = await this.prisma.agentDefinition.findMany({
      where: { ...(q.departmentId && { departmentId: q.departmentId }), ...(q.kind && { kind: q.kind }) },
      orderBy: { sortOrder: 'asc' },
      include: agentInclude,
    });
    const counts = await this.openTaskCounts(agents.map((a) => a.id));
    return agents.map((a) => ({ ...a, openTasks: counts.get(a.id) ?? 0 }));
  }

  async get(id: string) {
    const agent = await this.prisma.agentDefinition.findUnique({ where: { id }, include: agentInclude });
    if (!agent) throw new NotFoundException('Agent not found');
    const [counts, recentTasks] = await Promise.all([
      this.openTaskCounts([id]),
      this.prisma.task.findMany({
        where: { assignedAgentId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, status: true, priority: true, createdAt: true },
      }),
    ]);
    return { ...agent, openTasks: counts.get(id) ?? 0, recentTasks };
  }

  async update(id: string, dto: UpdateAgentDto, user: AuthUser, ctx: RequestContext) {
    const agent = await this.prisma.agentDefinition.findUnique({ where: { id }, include: { permissions: true } });
    if (!agent) throw new NotFoundException('Agent not found');

    if (dto.tools) {
      const tools = [...new Set(dto.tools)];
      const unknown = tools.filter((t) => !isToolName(t));
      if (unknown.length) throw new BadRequestException(`Unknown tools: ${unknown.join(', ')}`);
      const missing = toolsMissingPermissions(tools, agent.permissions.map((p) => p.permission));
      if (missing.length) {
        throw new BadRequestException(
          `Grant the required permission first for: ${missing.map((t) => `${t} (needs ${TOOLS[t as keyof typeof TOOLS].requires})`).join(', ')}`,
        );
      }
      dto.tools = tools;
    }

    const data: Prisma.AgentDefinitionUpdateInput = {
      ...(dto.role !== undefined && { role: dto.role }),
      ...(dto.instructions !== undefined && { instructions: dto.instructions }),
      ...(dto.reportingResponsibilities !== undefined && { reportingResponsibilities: dto.reportingResponsibilities }),
      ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
      ...(dto.modelTier !== undefined && { modelTier: dto.modelTier }),
      ...(dto.modelOverride !== undefined && { modelOverride: dto.modelOverride }),
      ...(dto.maxOutputTokens !== undefined && { maxOutputTokens: dto.maxOutputTokens }),
      ...(dto.tools !== undefined && { tools: dto.tools }),
    };
    const changed = Object.keys(data);
    if (!changed.length) return this.get(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.agentDefinition.update({ where: { id }, data });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'agent.update',
          entityType: 'agent_definition',
          entityId: id,
          data: { fields: changed, before: pick(agent, changed), after: pick(dto as Record<string, unknown>, changed) },
          ctx,
        },
        tx,
      );
    });
    this.events.emit({ type: 'agent.updated', agentId: id });
    return this.get(id);
  }

  /**
   * Replaces an agent's permission set. Only CEO/admin users reach this (enforced by the controller);
   * no agent tool exists that can call it, so agents cannot grant themselves permissions.
   */
  async setPermissions(id: string, dto: SetPermissionsDto, user: AuthUser, ctx: RequestContext) {
    const agent = await this.prisma.agentDefinition.findUnique({ where: { id }, include: { permissions: true } });
    if (!agent) throw new NotFoundException('Agent not found');

    const seen = new Set<string>();
    const grants = dto.permissions.map((g) => {
      if (!isPermissionKey(g.permission)) throw new BadRequestException(`Unknown permission: ${g.permission}`);
      if (seen.has(g.permission)) throw new BadRequestException(`Duplicate permission: ${g.permission}`);
      seen.add(g.permission);
      const def = PERMISSIONS[g.permission];
      if (!def.agentGrantable) throw new BadRequestException(`${g.permission} can only be held by people, not AI agents`);
      // Sensitive actions always go through human approval, whatever the request says.
      return { permission: g.permission, requiresApproval: def.approvalLocked ? true : g.requiresApproval };
    });

    const missing = toolsMissingPermissions(agent.tools, grants.map((g) => g.permission));
    if (missing.length) {
      throw new BadRequestException(`Remove these tools first, they need the permissions being removed: ${missing.join(', ')}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.agentPermission.deleteMany({ where: { agentId: id } });
      if (grants.length) await tx.agentPermission.createMany({ data: grants.map((g) => ({ ...g, agentId: id })) });
      await this.audit.record(
        {
          actorType: 'USER',
          actorUserId: user.id,
          action: 'agent.permissions.set',
          entityType: 'agent_definition',
          entityId: id,
          data: { before: agent.permissions.map((p) => ({ permission: p.permission, requiresApproval: p.requiresApproval })), after: grants },
          ctx,
        },
        tx,
      );
    });
    this.events.emit({ type: 'agent.updated', agentId: id });
    return this.get(id);
  }

  private async openTaskCounts(agentIds: string[]): Promise<Map<string, number>> {
    if (!agentIds.length) return new Map();
    const rows = await this.prisma.task.groupBy({
      by: ['assignedAgentId'],
      where: { assignedAgentId: { in: agentIds }, status: { in: [...ACTIVE_STATUSES] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.assignedAgentId as string, r._count._all]));
  }
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
