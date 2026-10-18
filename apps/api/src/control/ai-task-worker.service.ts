import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import type { AuthUser } from '../common/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { TaskRunnerService } from '../orchestration/task-runner.service';
import { ControlLogService, WorkflowStateService } from './control-core';

const POLL_MS = 5_000;
/** A task that errors without leaving QUEUED is skipped for this long so the worker can't spin on it. */
const SKIP_MS = 10 * 60_000;

export interface WorkerSnapshot {
  busy: boolean;
  current: { taskId: string; title: string; agentName: string | null; startedAt: string } | null;
  processed: number;
  succeeded: number;
  failed: number;
  awaitingApproval: number;
  lastError: string | null;
}

/**
 * Background executor behind "Start All". Picks QUEUED tasks whose assigned agent is enabled and whose
 * dependencies are complete, highest priority first, and runs them through the existing TaskRunnerService
 * (same approvals, registry-checked tools, state machine and audit trail as "Run with AI").
 *
 * One task at a time, no cascade (children are picked up as their own jobs), abortable by Stop All.
 */
@Injectable()
export class AiTaskWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiTaskWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private current: { taskId: string; title: string; agentName: string | null; startedAt: Date; controller: AbortController } | null = null;
  private readonly skipUntil = new Map<string, number>();
  private warnedNoAi = false;
  private stats = { processed: 0, succeeded: 0, failed: 0, awaitingApproval: 0, lastError: null as string | null };

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: TaskRunnerService,
    private readonly ai: AiService,
    private readonly workflows: WorkflowStateService,
    private readonly log: ControlLogService,
  ) {}

  onModuleInit(): void {
    // Tests drive the worker explicitly via runNext()/drain().
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.kick(), POLL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // Graceful shutdown: abort the in-flight model call so the task is recorded as stopped, not left RUNNING.
    this.abortCurrent();
    await this.running?.catch(() => undefined);
  }

  snapshot(): WorkerSnapshot {
    return {
      busy: this.current !== null,
      current: this.current
        ? { taskId: this.current.taskId, title: this.current.title, agentName: this.current.agentName, startedAt: this.current.startedAt.toISOString() }
        : null,
      ...this.stats,
    };
  }

  /** Non-blocking: start one pass if enabled and idle. */
  kick(): void {
    if (this.running || !this.workflows.isEnabled('ai-task-worker')) return;
    this.running = this.drain(25)
      .catch((err) => this.logger.warn(`Worker pass failed: ${err instanceof Error ? err.message : 'error'}`))
      .then(() => undefined)
      .finally(() => {
        this.running = null;
      });
  }

  /** Waits for the in-flight pass (used by Stop All and tests). */
  async idle(timeoutMs = 15_000): Promise<boolean> {
    if (!this.running) return true;
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      this.running.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return done;
  }

  /** Aborts the task currently executing (if any). Returns its id. */
  abortCurrent(): string | null {
    if (!this.current) return null;
    this.current.controller.abort();
    return this.current.taskId;
  }

  /** Process up to `max` eligible tasks sequentially while the workflow stays enabled. */
  async drain(max: number): Promise<number> {
    let n = 0;
    while (n < max && this.workflows.isEnabled('ai-task-worker')) {
      const did = await this.runNext();
      if (!did) break;
      n += 1;
    }
    return n;
  }

  /** Runs the next eligible task. Returns false when there was nothing to do (or AI is not configured). */
  async runNext(): Promise<boolean> {
    if (!this.ai.status.apiKeyConfigured || !this.ai.status.routineModel) {
      if (!this.warnedNoAi) {
        this.warnedNoAi = true;
        await this.log.log({ level: 'WARN', action: 'worker.blocked', message: 'AI task worker is on but the AI provider is not configured (OPENAI_API_KEY / OPENAI_MODEL).' });
      }
      this.workflows.recordTick('ai-task-worker', { ok: false, error: 'AI provider is not configured.' });
      return false;
    }
    this.warnedNoAi = false;

    const now = Date.now();
    for (const [id, until] of this.skipUntil) if (until <= now) this.skipUntil.delete(id);

    const task = await this.prisma.task.findFirst({
      where: {
        status: 'QUEUED',
        id: this.skipUntil.size ? { notIn: [...this.skipUntil.keys()] } : undefined,
        assignedAgent: { isEnabled: true },
        dependencies: { none: { dependsOn: { status: { not: 'COMPLETED' } } } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, createdById: true, assignedAgent: { select: { name: true } } },
    });
    if (!task) {
      this.workflows.recordTick('ai-task-worker', { ok: true, message: 'No eligible queued tasks.' });
      return false;
    }

    const actor = await this.resolveActor(task.createdById);
    if (!actor) {
      this.workflows.recordTick('ai-task-worker', { ok: false, error: 'No active CEO/admin account to act for.' });
      return false;
    }

    const controller = new AbortController();
    this.current = { taskId: task.id, title: task.title, agentName: task.assignedAgent?.name ?? null, startedAt: new Date(), controller };
    this.stats.processed += 1;
    try {
      const result = await this.runner.runTask(task.id, actor, { ip: null, userAgent: 'ai-task-worker' }, { cascade: false, signal: controller.signal });
      if (result.awaitingApproval) {
        this.stats.awaitingApproval += 1;
        await this.log.log({ action: 'worker.awaiting_approval', message: `"${task.title}" is waiting for your approval.`, data: { taskId: task.id } });
      } else if (result.task.status === 'COMPLETED') {
        this.stats.succeeded += 1;
        await this.log.log({
          action: 'worker.task_completed',
          message: `${task.assignedAgent?.name ?? 'Agent'} completed "${task.title}"${result.childrenCreated.length ? ` and created ${result.childrenCreated.length} subtask(s)` : ''}.`,
          data: { taskId: task.id, runId: result.runId, childrenCreated: result.childrenCreated.length },
        });
      } else if (result.task.status === 'FAILED') {
        this.stats.failed += 1;
        await this.log.log({ level: 'WARN', action: 'worker.task_blocked', message: `"${task.title}" ended blocked: ${result.task.errorMessage ?? 'see task'}.`, data: { taskId: task.id } });
      } else if (result.deduplicated) {
        this.skipUntil.set(task.id, Date.now() + SKIP_MS);
      }
      this.workflows.recordTick('ai-task-worker', { ok: true, message: `Ran "${task.title}".` });
    } catch (err) {
      const message = errorMessage(err);
      this.stats.failed += 1;
      this.stats.lastError = message;
      const after = await this.prisma.task.findUnique({ where: { id: task.id }, select: { status: true } });
      if (after?.status === 'QUEUED') this.skipUntil.set(task.id, Date.now() + SKIP_MS);
      await this.log.log({
        level: controller.signal.aborted ? 'WARN' : 'ERROR',
        action: controller.signal.aborted ? 'worker.task_stopped' : 'worker.task_failed',
        message: `"${task.title}": ${message}`,
        data: { taskId: task.id },
      });
      this.workflows.recordTick('ai-task-worker', { ok: false, error: message });
    } finally {
      this.current = null;
    }
    return true;
  }

  /** Acts as whoever created the task when they can still write; otherwise the active CEO. */
  private async resolveActor(createdById: string | null): Promise<AuthUser | null> {
    const pick = { id: true, email: true, name: true, role: true } as const;
    if (createdById) {
      const u = await this.prisma.user.findFirst({ where: { id: createdById, isActive: true, role: { in: ['CEO', 'ADMIN'] } }, select: pick });
      if (u) return u;
    }
    return this.prisma.user.findFirst({ where: { role: 'CEO', isActive: true }, select: pick, orderBy: { createdAt: 'asc' } });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const r = err.getResponse();
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object' && 'message' in r) {
      const m = (r as { message: string | string[] }).message;
      return Array.isArray(m) ? m.join('; ') : String(m);
    }
  }
  return err instanceof Error ? err.message.slice(0, 500) : 'AI execution failed.';
}
