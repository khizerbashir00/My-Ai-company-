import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_STATUSES } from '../tasks/task-state-machine';

export interface OrgNode {
  id: string;
  key: string;
  name: string;
  kind: string;
  role: string;
  isEnabled: boolean;
  modelTier: string;
  departmentId: string | null;
  openTasks: number;
  children: OrgNode[];
}

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [departments, taskCounts] = await Promise.all([
      this.prisma.department.findMany({
        orderBy: { sortOrder: 'asc' },
        include: {
          agents: { orderBy: { sortOrder: 'asc' }, select: { id: true, key: true, name: true, kind: true, isEnabled: true } },
        },
      }),
      this.prisma.task.groupBy({ by: ['departmentId', 'status'], _count: { _all: true } }),
    ]);
    return departments.map((d) => {
      const counts = taskCounts.filter((c) => c.departmentId === d.id);
      const sum = (pred: (s: string) => boolean) => counts.filter((c) => pred(c.status)).reduce((n, c) => n + c._count._all, 0);
      return {
        ...d,
        manager: d.agents.find((a) => a.kind === 'MANAGER') ?? null,
        workerCount: d.agents.filter((a) => a.kind === 'WORKER').length,
        taskStats: {
          open: sum((s) => (ACTIVE_STATUSES as readonly string[]).includes(s)),
          completed: sum((s) => s === 'COMPLETED'),
          failed: sum((s) => s === 'FAILED'),
        },
      };
    });
  }

  async get(id: string) {
    const all = await this.list();
    const dept = all.find((d) => d.id === id || d.key === id);
    if (!dept) throw new NotFoundException('Department not found');
    return dept;
  }

  /** CEO → General Manager → managers → workers, built from agent_definitions.parent_id. */
  async orgChart(): Promise<{ ceo: { title: string }; root: OrgNode[] }> {
    const [agents, open] = await Promise.all([
      this.prisma.agentDefinition.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.task.groupBy({
        by: ['assignedAgentId'],
        where: { status: { in: [...ACTIVE_STATUSES] }, assignedAgentId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const openBy = new Map(open.map((o) => [o.assignedAgentId as string, o._count._all]));
    const nodes = new Map<string, OrgNode>(
      agents.map((a) => [
        a.id,
        {
          id: a.id,
          key: a.key,
          name: a.name,
          kind: a.kind,
          role: a.role,
          isEnabled: a.isEnabled,
          modelTier: a.modelTier,
          departmentId: a.departmentId,
          openTasks: openBy.get(a.id) ?? 0,
          children: [],
        },
      ]),
    );
    const root: OrgNode[] = [];
    for (const a of agents) {
      const node = nodes.get(a.id)!;
      const parent = a.parentId ? nodes.get(a.parentId) : undefined;
      (parent ? parent.children : root).push(node);
    }
    return { ceo: { title: 'CEO' }, root };
  }
}
