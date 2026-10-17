import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ActorType, AgentKind, TaskKind, TaskStatus } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { Page, toPage } from '../common/pagination';
import { AppConfigService } from '../config/app-config.service';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto, ListTasksQueryDto, TransitionTaskDto, UpdateTaskDto } from './tasks.dto';
import { checkTransition, isTerminal } from './task-state-machine';

/** Who is performing a task mutation — HTTP handlers pass USER; the AI runner passes AGENT. */
export type TaskActor =
  | { type: 'USER'; userId: string }
  | { type: 'AGENT'; agentId: string; createdByUserId: string }
  | { type: 'SYSTEM'; createdByUserId?: string };

const KIND_FOR_AGENT: Record<AgentKind, TaskKind> = {
  GENERAL_MANAGER: 'GOAL',
  MANAGER: 'DEPARTMENT_TASK',
  WORKER: 'WORKER_TASK',
};

const listInclude = {
  department: { select: { id: true, key: true, name: true } },
  assignedAgent: { select: { id: true, key: true, name: true, kind: true } },
  _count: { select: { subtasks: true } },
} satisfies Prisma.TaskInclude;

const detailInclude = {
  ...listInclude,
  createdBy: { select: { id: true, name: true } },
  parentTask: { select: { id: true, title: true, status: true } },
  subtasks: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, status: true, kind: true, priority: true, assignedAgent: { select: { id: true, name: true } } },
  },
  dependencies: { select: { dependsOn: { select: { id: true, title: true, status: true } } } },
  events: {
    orderBy: { createdAt: 'asc' },
    include: { actorUser: { select: { id: true, name: true } }, actorAgent: { select: { id: true, name: true } } },
  },
  runs: {
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: { id: true, status: true, model: true, provider: true, startedAt: true, finishedAt: true, inputTokens: true, outputTokens: true, agent: { select: { id: true, name: true } } },
  },
} satisfies Prisma.TaskInclude;

export type TaskListItem = Prisma.TaskGetPayload<{ include: typeof listInclude }>;
export type TaskDetail = Prisma.TaskGetPayload<{ include: typeof detailInclude }>;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly config: AppConfigService,
  ) {}

  async list(q: ListTasksQueryDto): Promise<Page<TaskListItem>> {
    const where: Prisma.TaskWhereInput = {
      ...(q.status?.length && { status: { in: q.status } }),
      ...(q.kind && { kind: q.kind }),
      ...(q.priority && { priority: q.priority }),
      ...(q.departmentId && { departmentId: q.departmentId }),
      ...(q.assignedAgentId && { assignedAgentId: q.assignedAgentId }),
      ...(q.parentTaskId && { parentTaskId: q.parentTaskId === 'root' ? null : q.parentTaskId }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }),
      ...(q.search && {
        OR: [
          { title: { contains: q.search, mode: 'insensitive' } },
          { description: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };
    // Secondary sort by id keeps pagination stable when the primary key ties.
    const orderBy: Prisma.TaskOrderByWithRelationInput[] = [
      q.sortBy === 'dueAt' ? { dueAt: { sort: q.sortDir, nulls: 'last' } } : { [q.sortBy]: q.sortDir },
      { id: 'asc' },
    ];
    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: listInclude }),
      this.prisma.task.count({ where }),
    ]);
    return toPage(items, total, q.page, q.pageSize);
  }

  async get(id: string): Promise<TaskDetail> {
    const task = await this.prisma.task.findUnique({ where: { id }, include: detailInclude });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async create(dto: CreateTaskDto, user: AuthUser, ctx: RequestContext): Promise<{ task: TaskDetail; deduplicated: boolean }> {
    return this.createAs(dto, { type: 'USER', userId: user.id }, ctx);
  }

  /** Create a task as a user, agent, or system actor (used by the AI runner for delegated subtasks). */
  async createAs(
    dto: CreateTaskDto,
    actor: TaskActor,
    ctx?: RequestContext,
  ): Promise<{ task: TaskDetail; deduplicated: boolean }> {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.task.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, select: { id: true } });
      if (existing) return { task: await this.get(existing.id), deduplicated: true };
    }

    const { kind, departmentId } = await this.resolveAssignment(dto);

    if (dto.parentTaskId) {
      const parent = await this.prisma.task.findUnique({ where: { id: dto.parentTaskId }, select: { status: true } });
      if (!parent) throw new BadRequestException('Parent task not found');
      if (isTerminal(parent.status)) throw new BadRequestException(`Cannot add subtasks to a ${parent.status.toLowerCase()} task`);
    }

    const dependsOn = [...new Set(dto.dependsOn ?? [])];
    if (dependsOn.length) {
      const found = await this.prisma.task.count({ where: { id: { in: dependsOn } } });
      if (found !== dependsOn.length) throw new BadRequestException('One or more dependency tasks do not exist');
    }

    const createdById = actor.type === 'USER' ? actor.userId : actor.createdByUserId;
    if (!createdById) throw new BadRequestException('Task creation requires a creating user');
    const { actorType, actorUserId, actorAgentId } = actorFields(actor);

    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({
          data: {
            kind,
            title: dto.title,
            description: dto.description ?? '',
            priority: dto.priority ?? 'NORMAL',
            departmentId,
            assignedAgentId: dto.assignedAgentId ?? null,
            parentTaskId: dto.parentTaskId ?? null,
            createdById,
            dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
            maxAttempts: dto.maxAttempts ?? this.config.taskDefaultMaxAttempts,
            idempotencyKey: dto.idempotencyKey ?? null,
            input: (dto.input as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
            dependencies: { create: dependsOn.map((d) => ({ dependsOnId: d })) },
          },
        });
        await tx.taskEvent.create({
          data: {
            taskId: task.id,
            type: 'created',
            toStatus: 'QUEUED',
            message: 'Task created',
            actorType,
            actorUserId,
            actorAgentId,
          },
        });
        await this.audit.record(
          {
            actorType,
            actorUserId,
            actorAgentId,
            action: 'task.create',
            entityType: 'task',
            entityId: task.id,
            data: { title: task.title, kind },
            ctx,
          },
          tx,
        );
        return task.id;
      });
    } catch (err) {
      // Two identical requests raced: the loser returns the winner's task.
      if (dto.idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.task.findUniqueOrThrow({ where: { idempotencyKey: dto.idempotencyKey }, select: { id: true } });
        return { task: await this.get(winner.id), deduplicated: true };
      }
      throw err;
    }

    const task = await this.get(id);
    this.events.emit({ type: 'task.created', taskId: id, status: task.status, parentTaskId: task.parentTaskId });
    return { task, deduplicated: false };
  }

  async update(id: string, dto: UpdateTaskDto, user: AuthUser, ctx: RequestContext): Promise<TaskDetail> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (isTerminal(task.status)) throw new BadRequestException(`A ${task.status.toLowerCase()} task can no longer be edited`);
    if (dto.maxAttempts !== undefined && dto.maxAttempts < task.attempts) {
      throw new BadRequestException(`Retry limit cannot be lower than attempts already made (${task.attempts})`);
    }

    const data: Prisma.TaskUpdateInput = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.dueAt !== undefined && { dueAt: dto.dueAt === null ? null : new Date(dto.dueAt) }),
      ...(dto.maxAttempts !== undefined && { maxAttempts: dto.maxAttempts }),
    };
    const changed = Object.keys(data);
    if (!changed.length) return this.get(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id }, data });
      await tx.taskEvent.create({
        data: { taskId: id, type: 'updated', message: `Updated ${changed.join(', ')}`, actorType: 'USER', actorUserId: user.id, data: { fields: changed } },
      });
      await this.audit.record({ actorType: 'USER', actorUserId: user.id, action: 'task.update', entityType: 'task', entityId: id, data: { ...dto }, ctx }, tx);
    });
    this.events.emit({ type: 'task.updated', taskId: id, status: task.status, parentTaskId: task.parentTaskId });
    return this.get(id);
  }

  async transition(id: string, dto: TransitionTaskDto, user: AuthUser, ctx: RequestContext): Promise<TaskDetail> {
    return this.transitionAs(id, dto, { type: 'USER', userId: user.id }, ctx);
  }

  /** Transition a task as a user, agent, or system actor (compare-and-set; used by the AI runner). */
  async transitionAs(id: string, dto: TransitionTaskDto, actor: TaskActor, ctx?: RequestContext): Promise<TaskDetail> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { dependencies: { select: { dependsOn: { select: { status: true } } } } },
    });
    if (!task) throw new NotFoundException('Task not found');

    const unmetDependencies = task.dependencies.filter((d) => d.dependsOn.status !== 'COMPLETED').length;
    const check = checkTransition(task.status, dto.to, {
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      unmetDependencies,
      message: dto.message,
    });
    if (!check.ok) throw new BadRequestException(check.reason);

    const now = new Date();
    const data: Prisma.TaskUpdateManyMutationInput = { status: dto.to };
    if (dto.to === 'RUNNING' && task.status === 'QUEUED') {
      data.attempts = { increment: 1 };
      data.startedAt = now;
      data.errorMessage = null;
    }
    if (dto.to === 'COMPLETED' || dto.to === 'CANCELLED') data.completedAt = now;
    if (dto.to === 'FAILED') data.errorMessage = dto.message!.trim();
    if (dto.to === 'AWAITING_APPROVAL' || dto.to === 'QUEUED') {
      // Clear completion stamp when leaving a finished-looking path (retries / waiting).
      if (dto.to === 'QUEUED') data.completedAt = null;
    }

    const { actorType, actorUserId, actorAgentId } = actorFields(actor);
    const cascaded: { id: string; parentTaskId: string | null }[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: if another actor changed the status meanwhile, nothing is updated.
      const res = await tx.task.updateMany({ where: { id, status: task.status }, data });
      if (res.count !== 1) throw new ConflictException('This task was changed by someone else. Refresh and try again.');

      await tx.taskEvent.create({
        data: {
          taskId: id,
          type: task.status === 'FAILED' && dto.to === 'QUEUED' ? 'retry' : 'status_changed',
          fromStatus: task.status,
          toStatus: dto.to,
          message: dto.message?.trim() || `${task.status} → ${dto.to}`,
          actorType,
          actorUserId,
          actorAgentId,
        },
      });

      if (dto.to === 'CANCELLED') cascaded.push(...(await this.cancelDescendants(tx, id, actor, now)));

      await this.audit.record(
        {
          actorType,
          actorUserId,
          actorAgentId,
          action: 'task.transition',
          entityType: 'task',
          entityId: id,
          data: { from: task.status, to: dto.to, message: dto.message, cascadedCancellations: cascaded.length },
          ctx,
        },
        tx,
      );
    });

    this.events.emit({ type: 'task.updated', taskId: id, status: dto.to, parentTaskId: task.parentTaskId });
    for (const c of cascaded) this.events.emit({ type: 'task.updated', taskId: c.id, status: 'CANCELLED', parentTaskId: c.parentTaskId });

    if (dto.to === 'FAILED' && task.attempts >= task.maxAttempts) {
      await this.notifications
        .notifyCeo({
          type: 'TASK_FAILED_REPEATEDLY',
          title: 'Task failed repeatedly',
          body: `“${task.title}” reached ${task.attempts}/${task.maxAttempts} attempts.`,
          link: `/tasks/${id}`,
          dedupeKey: `task-failed-max:${id}:${task.attempts}`,
        })
        .catch(() => undefined);
    }

    return this.get(id);
  }

  /** Persist structured AI output on a task (does not change status by itself). */
  async setOutput(id: string, output: Record<string, unknown>): Promise<void> {
    await this.prisma.task.update({
      where: { id },
      data: { output: output as Prisma.InputJsonValue },
    });
  }

  /** Cancels every non-terminal descendant (breadth-first). */
  private async cancelDescendants(tx: Prisma.TransactionClient, rootId: string, actor: TaskActor, now: Date) {
    const { actorType, actorUserId, actorAgentId } = actorFields(actor);
    const cancelled: { id: string; parentTaskId: string | null }[] = [];
    let frontier = [rootId];
    while (frontier.length) {
      const children = await tx.task.findMany({
        where: { parentTaskId: { in: frontier } },
        select: { id: true, status: true, parentTaskId: true },
      });
      for (const child of children) {
        if (isTerminal(child.status)) continue;
        await tx.task.update({ where: { id: child.id }, data: { status: 'CANCELLED', completedAt: now } });
        await tx.taskEvent.create({
          data: {
            taskId: child.id,
            type: 'status_changed',
            fromStatus: child.status as TaskStatus,
            toStatus: 'CANCELLED',
            message: 'Cancelled because its parent task was cancelled',
            actorType,
            actorUserId,
            actorAgentId,
          },
        });
        cancelled.push({ id: child.id, parentTaskId: child.parentTaskId });
      }
      frontier = children.map((c) => c.id);
    }
    return cancelled;
  }

  /** Derives task kind and department from the assigned agent, and rejects inconsistent combinations. */
  private async resolveAssignment(dto: CreateTaskDto): Promise<{ kind: TaskKind; departmentId: string | null }> {
    if (dto.departmentId) {
      const dept = await this.prisma.department.findUnique({ where: { id: dto.departmentId }, select: { isActive: true } });
      if (!dept) throw new BadRequestException('Department not found');
      if (!dept.isActive) throw new BadRequestException('Department is inactive');
    }
    if (!dto.assignedAgentId) {
      const kind = dto.kind ?? (dto.departmentId ? 'DEPARTMENT_TASK' : 'GOAL');
      if (kind === 'WORKER_TASK') throw new BadRequestException('Worker tasks must be assigned to a worker');
      if (kind === 'DEPARTMENT_TASK' && !dto.departmentId) throw new BadRequestException('Department tasks need a department');
      return { kind, departmentId: dto.departmentId ?? null };
    }

    const agent = await this.prisma.agentDefinition.findUnique({
      where: { id: dto.assignedAgentId },
      select: { kind: true, departmentId: true, isEnabled: true, name: true },
    });
    if (!agent) throw new BadRequestException('Assigned agent not found');
    if (!agent.isEnabled) throw new BadRequestException(`${agent.name} is disabled`);
    if (dto.departmentId && agent.departmentId && dto.departmentId !== agent.departmentId) {
      throw new BadRequestException(`${agent.name} does not belong to that department`);
    }
    const kind = KIND_FOR_AGENT[agent.kind];
    if (dto.kind && dto.kind !== kind) {
      throw new BadRequestException(`${agent.name} handles ${kind.replace('_', ' ').toLowerCase()}s, not ${dto.kind.replace('_', ' ').toLowerCase()}s`);
    }
    return { kind, departmentId: agent.departmentId ?? dto.departmentId ?? null };
  }
}

function actorFields(actor: TaskActor): {
  actorType: ActorType;
  actorUserId: string | null;
  actorAgentId: string | null;
} {
  if (actor.type === 'USER') return { actorType: 'USER', actorUserId: actor.userId, actorAgentId: null };
  if (actor.type === 'AGENT') return { actorType: 'AGENT', actorUserId: null, actorAgentId: actor.agentId };
  return { actorType: 'SYSTEM', actorUserId: null, actorAgentId: null };
}
