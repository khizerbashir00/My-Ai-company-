import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { Prisma, type ControlEventLevel } from '../generated/prisma/client';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';

/** Background workflows the Control Center can start and stop. */
export type WorkflowKey = 'ai-task-worker' | 'lead-source-scans' | 'outreach-follow-ups';

export interface WorkflowDefinition {
  key: WorkflowKey;
  name: string;
  description: string;
  /** State when nobody has pressed Start/Stop yet. Keeps pre-existing behavior on upgrade. */
  defaultEnabled: boolean;
}

export const WORKFLOWS: WorkflowDefinition[] = [
  {
    key: 'ai-task-worker',
    name: 'AI task worker',
    description:
      'Runs queued tasks assigned to enabled AI agents, one at a time, with the same approvals and tool limits as "Run with AI". Off until you press Start, because it spends AI credits.',
    defaultEnabled: false,
  },
  {
    key: 'lead-source-scans',
    name: 'Lead-source scans',
    description: 'Scans enabled, authorized lead sources (Hacker News, Reddit) on their configured interval.',
    defaultEnabled: true,
  },
  {
    key: 'outreach-follow-ups',
    name: 'Outreach follow-ups',
    description: 'Moves CEO-scheduled follow-ups into the approval/send path when they come due. Never sends unapproved messages.',
    defaultEnabled: true,
  },
];

export interface WorkflowRuntime {
  lastTickAt: Date | null;
  lastResult: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** Writes the Control Center operations log and pushes a live update. Never stores secrets. */
@Injectable()
export class ControlLogService {
  private readonly logger = new Logger('ControlLog');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async log(entry: { level?: ControlEventLevel; action: string; message: string; data?: Record<string, unknown>; actorUserId?: string | null }): Promise<void> {
    try {
      await this.prisma.controlEvent.create({
        data: {
          level: entry.level ?? 'INFO',
          action: entry.action,
          message: entry.message.slice(0, 2000),
          data: entry.data ? (entry.data as Prisma.InputJsonValue) : Prisma.JsonNull,
          actorUserId: entry.actorUserId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not write control event ${entry.action}: ${err instanceof Error ? err.message : 'error'}`);
    }
    this.events.emit({ type: 'control.updated', reason: entry.action });
  }

  async recent(limit = 60) {
    return this.prisma.controlEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  }
}

/**
 * Persisted on/off switches for background workflows (table workflow_controls).
 * Schedulers check isEnabled() on every tick, so Stop takes effect immediately and survives restarts.
 */
@Injectable()
export class WorkflowStateService implements OnModuleInit {
  private readonly enabled = new Map<WorkflowKey, boolean>();
  private readonly runtime = new Map<WorkflowKey, WorkflowRuntime>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const rows = await this.prisma.workflowControl.findMany();
    this.enabled.clear();
    for (const r of rows) {
      if (WORKFLOWS.some((w) => w.key === r.key)) this.enabled.set(r.key as WorkflowKey, r.isEnabled);
    }
  }

  isEnabled(key: WorkflowKey): boolean {
    return this.enabled.get(key) ?? WORKFLOWS.find((w) => w.key === key)!.defaultEnabled;
  }

  async setEnabled(key: WorkflowKey, enabled: boolean, userId: string | null): Promise<void> {
    const now = new Date();
    await this.prisma.workflowControl.upsert({
      where: { key },
      create: { key, isEnabled: enabled, updatedById: userId, ...(enabled ? { lastStartedAt: now } : { lastStoppedAt: now }) },
      update: { isEnabled: enabled, updatedById: userId, ...(enabled ? { lastStartedAt: now } : { lastStoppedAt: now }) },
    });
    this.enabled.set(key, enabled);
    this.events.emit({ type: 'control.updated', reason: `workflow:${key}` });
  }

  recordTick(key: WorkflowKey, result: { ok: true; message: string } | { ok: false; error: string }): void {
    const prev = this.runtimeFor(key);
    const now = new Date();
    this.runtime.set(
      key,
      result.ok
        ? { ...prev, lastTickAt: now, lastResult: result.message }
        : { ...prev, lastTickAt: now, lastError: result.error.slice(0, 500), lastErrorAt: now },
    );
  }

  runtimeFor(key: WorkflowKey): WorkflowRuntime {
    return this.runtime.get(key) ?? { lastTickAt: null, lastResult: null, lastError: null, lastErrorAt: null };
  }

  async rows() {
    return this.prisma.workflowControl.findMany();
  }
}

@Global()
@Module({
  providers: [ControlLogService, WorkflowStateService],
  exports: [ControlLogService, WorkflowStateService],
})
export class ControlCoreModule {}
