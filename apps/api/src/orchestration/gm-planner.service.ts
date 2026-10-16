import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ExecutionPlan } from '../ai/schemas';

/**
 * Validates and normalizes General Manager / manager plans against the live org chart.
 * Planning itself is performed by the task runner via the AI provider; this service
 * ensures steps only target real, enabled direct reports.
 */
@Injectable()
export class GmPlannerService {
  constructor(private readonly prisma: PrismaService) {}

  async assertPlanAssignees(plannerAgentId: string, plan: ExecutionPlan): Promise<string[]> {
    const children = await this.prisma.agentDefinition.findMany({
      where: { parentId: plannerAgentId, isEnabled: true },
      select: { key: true, department: { select: { key: true } } },
    });
    const byKey = new Map(children.map((c) => [c.key, c]));
    const errors: string[] = [];

    for (const step of plan.steps) {
      const child = byKey.get(step.assigneeAgentKey);
      if (!child) {
        errors.push(`Step "${step.key}" assigns unknown or non-direct report "${step.assigneeAgentKey}".`);
        continue;
      }
      if (child.department?.key && child.department.key !== step.departmentKey) {
        errors.push(
          `Step "${step.key}" department "${step.departmentKey}" does not match assignee ${step.assigneeAgentKey} (${child.department.key}).`,
        );
      }
    }
    return errors;
  }
}
