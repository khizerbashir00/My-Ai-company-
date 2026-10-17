import { BadRequestException, Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { AppConfigService } from '../config/app-config.service';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { RedditConnector } from '../connectors/reddit/reddit.connector';
import { PrismaService } from '../prisma/prisma.service';
import { SocialService } from '../social/social.service';
import { ScanQueueService } from '../sources/scan-queue.service';
import { ScanSchedulerService } from '../sources/scan-scheduler.service';
import { ScanService } from '../sources/scan.service';
import { TasksService } from '../tasks/tasks.service';
import { AiTaskWorkerService } from './ai-task-worker.service';
import { ControlLogService, WORKFLOWS, WorkflowStateService, type WorkflowKey } from './control-core';
import { RecoveryService } from './recovery.service';

export interface ActionItem {
  target: string;
  ok: boolean;
  message: string;
}

export interface ActionResult {
  action: 'start_all' | 'stop_all' | 'restart_failed' | 'connect_all' | 'workflow_start' | 'workflow_stop';
  at: string;
  ok: boolean;
  summary: string;
  items: ActionItem[];
}

const RESTART_SCAN_LIMIT = 50;
const RESTART_TASK_LIMIT = 200;

@Injectable()
export class ControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly log: ControlLogService,
    private readonly workflows: WorkflowStateService,
    private readonly worker: AiTaskWorkerService,
    private readonly recovery: RecoveryService,
    private readonly scan: ScanService,
    private readonly scanQueue: ScanQueueService,
    private readonly scanScheduler: ScanSchedulerService,
    private readonly tasks: TasksService,
    private readonly social: SocialService,
    private readonly connectors: ConnectorRegistry,
  ) {}

  private get aiReady(): boolean {
    return this.ai.status.apiKeyConfigured && this.ai.status.routineModel !== null;
  }

  // ───────────────────────────── single workflow ─────────────────────────────

  private assertKey(key: string): WorkflowKey {
    if (!WORKFLOWS.some((w) => w.key === key)) throw new BadRequestException(`Unknown workflow "${key}".`);
    return key as WorkflowKey;
  }

  private async startOne(key: WorkflowKey, user: AuthUser): Promise<ActionItem> {
    const name = WORKFLOWS.find((w) => w.key === key)!.name;
    if (key === 'ai-task-worker') {
      if (!this.aiReady) {
        return { target: key, ok: false, message: `${name} not started: AI provider is not configured (set OPENAI_API_KEY and OPENAI_MODEL, then restart the API).` };
      }
      await this.workflows.setEnabled(key, true, user.id);
      const eligible = await this.eligibleQueuedTasks();
      this.worker.kick();
      return { target: key, ok: true, message: `${name} started — ${eligible} eligible queued task(s).` };
    }
    if (key === 'lead-source-scans') {
      await this.workflows.setEnabled(key, true, user.id);
      await this.scanQueue.resume();
      const queued = await this.scanScheduler.tick();
      const ready = await this.authorizedSourceCount();
      return {
        target: key,
        ok: true,
        message: `${name} started — ${ready} enabled, authorized source connection(s); ${queued} due scan(s) queued now.${ready === 0 ? ' Enable and configure a source under Sources for scans to run.' : ''}`,
      };
    }
    await this.workflows.setEnabled(key, true, user.id);
    return { target: key, ok: true, message: `${name} started.` };
  }

  private async stopOne(key: WorkflowKey, user: AuthUser): Promise<ActionItem> {
    const name = WORKFLOWS.find((w) => w.key === key)!.name;
    await this.workflows.setEnabled(key, false, user.id);
    if (key === 'ai-task-worker') {
      const aborted = this.worker.abortCurrent();
      const settled = await this.worker.idle(15_000);
      return {
        target: key,
        ok: true,
        message: `${name} stopped${aborted ? '; the in-flight task was aborted and recorded as failed (retryable)' : ''}${settled ? '' : ' — still finishing its last step'}. Queued tasks are kept.`,
      };
    }
    if (key === 'lead-source-scans') {
      await this.scanQueue.pause();
      const aborted = this.scan.abortAll();
      const cancelled = await this.scanQueue.cancelQueued('Cancelled by Stop (Control Center).');
      return { target: key, ok: true, message: `${name} stopped — ${aborted} running scan(s) aborted, ${cancelled} queued scan(s) cancelled.` };
    }
    return { target: key, ok: true, message: `${name} stopped — due follow-ups will wait until you start it again.` };
  }

  async setWorkflow(rawKey: string, enabled: boolean, user: AuthUser, ctx: RequestContext): Promise<ActionResult> {
    const key = this.assertKey(rawKey);
    const item = enabled ? await this.startOne(key, user) : await this.stopOne(key, user);
    return this.finish(enabled ? 'workflow_start' : 'workflow_stop', [item], user, ctx);
  }

  // ───────────────────────────── global actions ─────────────────────────────

  async startAll(user: AuthUser, ctx: RequestContext): Promise<ActionResult> {
    const items: ActionItem[] = [];
    for (const w of WORKFLOWS) items.push(await this.startOne(w.key, user));

    const agents = await this.prisma.agentDefinition.groupBy({ by: ['isEnabled'], _count: { _all: true } });
    const enabled = agents.find((a) => a.isEnabled)?._count._all ?? 0;
    const disabled = agents.find((a) => !a.isEnabled)?._count._all ?? 0;
    items.push({
      target: 'agents',
      ok: enabled > 0,
      message: `${enabled} AI agent(s) eligible${disabled ? `; ${disabled} disabled agent(s) left off (enable them under Organization)` : ''}.`,
    });
    return this.finish('start_all', items, user, ctx);
  }

  async stopAll(user: AuthUser, ctx: RequestContext): Promise<ActionResult> {
    const items: ActionItem[] = [];
    // Stop the worker first so it cannot pick new tasks while scans are being cancelled.
    for (const key of ['ai-task-worker', 'lead-source-scans', 'outreach-follow-ups'] as WorkflowKey[]) {
      items.push(await this.stopOne(key, user));
    }
    return this.finish('stop_all', items, user, ctx);
  }

  async restartFailed(user: AuthUser, ctx: RequestContext): Promise<ActionResult> {
    const items: ActionItem[] = [];

    // 1. Tasks: FAILED → QUEUED through the state machine's retry edge (respects max attempts).
    const failed = await this.prisma.task.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'desc' },
      take: RESTART_TASK_LIMIT,
      select: { id: true, title: true, attempts: true, maxAttempts: true, assignedAgent: { select: { isEnabled: true, name: true } } },
    });
    let requeued = 0;
    const skipped: Record<string, number> = {};
    const bump = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
    for (const t of failed) {
      if (!t.assignedAgent) {
        bump('no assigned agent');
        continue;
      }
      if (!t.assignedAgent.isEnabled) {
        bump('agent disabled');
        continue;
      }
      if (t.attempts >= t.maxAttempts) {
        bump('retry limit reached (raise max attempts on the task)');
        continue;
      }
      try {
        await this.tasks.transitionAs(t.id, { to: 'QUEUED', message: 'Re-queued by Restart Failed (Control Center).' }, { type: 'USER', userId: user.id }, ctx);
        requeued += 1;
      } catch {
        bump('state changed concurrently');
      }
    }
    const skippedText = Object.entries(skipped)
      .map(([r, n]) => `${n} ${r}`)
      .join(', ');
    items.push({
      target: 'tasks',
      ok: true,
      message: failed.length
        ? `${requeued} of ${failed.length} failed task(s) re-queued${skippedText ? `; skipped: ${skippedText}` : ''}.${requeued && !this.workflows.isEnabled('ai-task-worker') ? ' The AI task worker is stopped — press Start All (or Run with AI on each task) to execute them.' : ''}`
        : 'No failed tasks.',
    });
    if (requeued) this.worker.kick();

    // 2. Scans: connections whose latest scan failed get a fresh scan.
    const connections = await this.prisma.sourceConnection.findMany({
      where: { status: { not: 'DISABLED' }, source: { isEnabled: true } },
      select: { id: true, source: { select: { name: true } }, scanRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
      take: RESTART_SCAN_LIMIT,
    });
    const failedConns = connections.filter((c) => c.scanRuns[0]?.status === 'FAILED');
    let scansQueued = 0;
    const scanProblems: string[] = [];
    for (const c of failedConns) {
      try {
        const runId = await this.scan.createRun(c.id, 'MANUAL');
        await this.scanQueue.enqueue(runId);
        scansQueued += 1;
      } catch (err) {
        scanProblems.push(`${c.source.name}: ${err instanceof Error ? err.message : 'could not queue'}`);
      }
    }
    items.push({
      target: 'scans',
      ok: scanProblems.length === 0,
      message: failedConns.length
        ? `${scansQueued} of ${failedConns.length} failed source scan(s) queued again${this.scanQueue.isPaused ? ' (scans are stopped — they will run when you start them)' : ''}.${scanProblems.length ? ` Not retried: ${scanProblems.join('; ')}` : ''}`
        : 'No failed source scans.',
    });

    // 3. Social connections in ERROR: re-test them (refreshes tokens when possible).
    const socialErrors = await this.prisma.socialAccount.findMany({ where: { status: 'ERROR' }, select: { platform: true } });
    for (const s of socialErrors) {
      const st = await this.social.verify(s.platform, user).catch(() => null);
      items.push({
        target: `social:${s.platform.toLowerCase()}`,
        ok: st?.status === 'CONNECTED',
        message: st?.status === 'CONNECTED' ? `${st.name} reconnected.` : `${st?.name ?? s.platform} still failing${st?.lastError ? `: ${st.lastError}` : ''}. Reconnect it.`,
      });
    }

    // 4. Failed email sends are never retried automatically — they need a human look.
    const failedSends = await this.prisma.outreachMessage.count({ where: { status: 'FAILED' } });
    if (failedSends) {
      items.push({ target: 'outreach', ok: true, message: `${failedSends} failed outreach send(s) were not retried automatically — review them on each lead before re-sending.` });
    }
    return this.finish('restart_failed', items, user, ctx);
  }

  /**
   * Starts the next pending OAuth connection. Browsers can only visit one consent screen at a time, so
   * the UI follows `next.authorizationUrl`; the callback returns with connectAll=1 and the UI calls this
   * again until nothing is pending.
   */
  async connectAll(user: AuthUser, ctx: RequestContext) {
    const statuses = await this.social.statusAll();
    const pending = statuses.filter((s) => s.configured && s.status !== 'CONNECTED');
    const connected = statuses.filter((s) => s.status === 'CONNECTED').map((s) => s.platform);
    const unconfigured = statuses.filter((s) => !s.configured).map((s) => ({ platform: s.platform, name: s.name, missing: s.missing }));
    const next = pending[0] ? await this.social.startConnect(pending[0].platform, user, { connectAll: true }) : null;

    const items: ActionItem[] = [
      ...connected.map((p) => ({ target: `social:${p.toLowerCase()}`, ok: true, message: `${statuses.find((s) => s.platform === p)!.name} already connected.` })),
      ...pending.map((p, i) => ({
        target: `social:${p.platform.toLowerCase()}`,
        ok: true,
        message: i === 0 ? `Opening ${p.name} authorization…` : `${p.name} will open after the previous one completes.`,
      })),
      ...unconfigured.map((u) => ({ target: `social:${u.platform.toLowerCase()}`, ok: false, message: `${u.name} needs server configuration: ${u.missing.join(', ')}.` })),
    ];
    const result = await this.finish('connect_all', items, user, ctx);
    return { ...result, next, pending: pending.map((p) => p.platform), connected, unconfigured };
  }

  private async finish(action: ActionResult['action'], items: ActionItem[], user: AuthUser, ctx: RequestContext): Promise<ActionResult> {
    const ok = items.every((i) => i.ok);
    const label = {
      start_all: 'Start All',
      stop_all: 'Stop All',
      restart_failed: 'Restart Failed',
      connect_all: 'Connect All',
      workflow_start: 'Start',
      workflow_stop: 'Stop',
    }[action];
    const summary = `${label}: ${items.filter((i) => i.ok).length}/${items.length} succeeded.`;
    await this.audit.record({ actorType: 'USER', actorUserId: user.id, action: `control.${action}`, entityType: 'control', data: { items }, ctx });
    await this.log.log({ level: ok ? 'INFO' : 'WARN', action: `control.${action}`, message: `${summary} ${items.map((i) => i.message).join(' ')}`.trim(), data: { items }, actorUserId: user.id });
    return { action, at: new Date().toISOString(), ok, summary, items };
  }

  // ───────────────────────────── status ─────────────────────────────

  private async eligibleQueuedTasks(): Promise<number> {
    return this.prisma.task.count({
      where: { status: 'QUEUED', assignedAgent: { isEnabled: true }, dependencies: { none: { dependsOn: { status: { not: 'COMPLETED' } } } } },
    });
  }

  private async authorizedSourceCount(): Promise<number> {
    const conns = await this.prisma.sourceConnection.findMany({
      where: { status: { not: 'DISABLED' }, source: { isEnabled: true } },
      select: { config: true, source: { select: { key: true } } },
    });
    return conns.filter((c) => {
      const connector = this.connectors.get(c.source.key);
      return connector && connector.isAuthorized(process.env) && connector.validateConfig((c.config as Record<string, unknown> | null) ?? {}).length === 0;
    }).length;
  }

  async status() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      agents,
      openTaskGroups,
      doneToday,
      lastRuns,
      people,
      recentRuns,
      recentScans,
      goals,
      taskTotals,
      scanTotals,
      social,
      events,
      workflowRows,
      queueCounts,
      eligibleQueued,
      authorizedSources,
      dueFollowUps,
      scheduledFollowUps,
      failedSends,
    ] = await Promise.all([
      this.prisma.agentDefinition.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, key: true, name: true, kind: true, role: true, isEnabled: true, parentId: true, department: { select: { key: true, name: true } } },
      }),
      this.prisma.task.groupBy({
        by: ['assignedAgentId', 'status'],
        where: { assignedAgentId: { not: null }, status: { in: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'FAILED'] } },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({ by: ['assignedAgentId'], where: { status: 'COMPLETED', completedAt: { gte: startOfDay } }, _count: { _all: true } }),
      this.prisma.agentRun.findMany({
        distinct: ['agentId'],
        orderBy: { startedAt: 'desc' },
        select: { agentId: true, status: true, startedAt: true, finishedAt: true, errorMessage: true, task: { select: { id: true, title: true } } },
      }),
      this.prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true, role: true, isActive: true, lastLoginAt: true } }),
      this.prisma.agentRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 15,
        select: {
          id: true,
          status: true,
          model: true,
          startedAt: true,
          finishedAt: true,
          errorMessage: true,
          inputTokens: true,
          outputTokens: true,
          agent: { select: { name: true } },
          task: { select: { id: true, title: true, status: true } },
        },
      }),
      this.prisma.sourceScanRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true,
          status: true,
          trigger: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          itemsFound: true,
          itemsCreated: true,
          itemsDeduped: true,
          errorMessage: true,
          connection: { select: { source: { select: { name: true } } } },
        },
      }),
      this.prisma.task.findMany({
        where: { kind: 'GOAL', status: { notIn: ['CANCELLED'] } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: { id: true, title: true, status: true, updatedAt: true, subtasks: { select: { status: true } } },
      }),
      this.prisma.task.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.sourceScanRun.groupBy({ by: ['status'], where: { status: { in: ['QUEUED', 'RUNNING'] } }, _count: { _all: true } }),
      this.social.statusAll(),
      this.log.recent(60),
      this.workflows.rows(),
      this.scanQueue.queueCounts(),
      this.eligibleQueuedTasks(),
      this.authorizedSourceCount(),
      this.prisma.outreachMessage.count({ where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } } }),
      this.prisma.outreachMessage.count({ where: { status: 'SCHEDULED' } }),
      this.prisma.outreachMessage.count({ where: { status: 'FAILED' } }),
    ]);

    const workerSnap = this.worker.snapshot();
    const count = (agentId: string, status: string) =>
      openTaskGroups.find((g) => g.assignedAgentId === agentId && g.status === status)?._count._all ?? 0;

    const agentRows = agents.map((a) => {
      const queued = count(a.id, 'QUEUED');
      const running = count(a.id, 'RUNNING');
      const awaiting = count(a.id, 'AWAITING_APPROVAL');
      const failedTasks = count(a.id, 'FAILED');
      const last = lastRuns.find((r) => r.agentId === a.id) ?? null;
      const state = !a.isEnabled
        ? 'disabled'
        : running > 0
          ? 'working'
          : failedTasks > 0 || awaiting > 0
            ? 'attention'
            : queued > 0
              ? 'queued'
              : 'idle';
      return {
        id: a.id,
        key: a.key,
        name: a.name,
        kind: a.kind,
        role: a.role,
        department: a.department,
        parentId: a.parentId,
        isEnabled: a.isEnabled,
        state,
        tasks: { queued, running, awaitingApproval: awaiting, failed: failedTasks, completedToday: doneToday.find((d) => d.assignedAgentId === a.id)?._count._all ?? 0 },
        lastRun: last
          ? { status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt, errorMessage: last.errorMessage, task: last.task }
          : null,
      };
    });

    const scanActive = scanTotals.reduce((n, g) => n + g._count._all, 0);
    const wf = (key: WorkflowKey) => {
      const def = WORKFLOWS.find((w) => w.key === key)!;
      const row = workflowRows.find((r) => r.key === key);
      const enabled = this.workflows.isEnabled(key);
      const runtime = this.workflows.runtimeFor(key);
      let state: 'running' | 'idle' | 'stopped' | 'blocked' = enabled ? 'idle' : 'stopped';
      let blockedReason: string | null = null;
      let detail: Record<string, unknown> = {};
      if (key === 'ai-task-worker') {
        if (enabled && !this.aiReady) {
          state = 'blocked';
          blockedReason = 'AI provider is not configured (OPENAI_API_KEY / OPENAI_MODEL).';
        } else if (enabled && workerSnap.busy) state = 'running';
        detail = { eligibleQueuedTasks: eligibleQueued, ...workerSnap };
      } else if (key === 'lead-source-scans') {
        if (enabled && scanActive > 0) state = 'running';
        if (enabled && authorizedSources === 0) {
          state = 'blocked';
          blockedReason = 'No enabled, authorized and configured lead source (see Sources).';
        }
        detail = { jobsMode: this.scanQueue.jobsMode, queuePaused: this.scanQueue.isPaused, queueCounts, activeScans: scanActive, authorizedSources };
      } else {
        detail = { dueNow: dueFollowUps, scheduled: scheduledFollowUps, emailConfigured: this.config.emailStatus.configured };
      }
      return {
        key,
        name: def.name,
        description: def.description,
        enabled,
        state,
        blockedReason,
        lastStartedAt: row?.lastStartedAt ?? null,
        lastStoppedAt: row?.lastStoppedAt ?? null,
        ...runtime,
        detail,
      };
    };

    const redditConnector = this.connectors.get(this.connectors.redditKey);
    return {
      generatedAt: new Date().toISOString(),
      environment: this.config.nodeEnv,
      ai: this.ai.status,
      email: { configured: this.config.emailStatus.configured },
      workflows: WORKFLOWS.map((w) => wf(w.key)),
      monitors: [{ key: 'ai-budget-alerts', name: 'AI budget alerts', enabled: this.config.aiDailyEstimatedUsdBudget !== null, note: 'Always on when AI_DAILY_ESTIMATED_USD_BUDGET is set — not affected by Stop All.' }],
      totals: {
        tasks: Object.fromEntries(taskTotals.map((g) => [g.status, g._count._all])),
        agents: { total: agentRows.length, enabled: agentRows.filter((a) => a.isEnabled).length, working: agentRows.filter((a) => a.state === 'working').length },
        scansActive: scanActive,
        failedSends,
        socialConnected: social.filter((s) => s.status === 'CONNECTED').length,
        socialTotal: social.length,
      },
      agents: agentRows,
      people: people.map((p) => ({ id: p.id, name: p.name, role: p.role, isActive: p.isActive, lastLoginAt: p.lastLoginAt })),
      jobs: {
        agentRuns: recentRuns.map((r) => ({
          id: r.id,
          status: r.status,
          model: r.model,
          agentName: r.agent.name,
          task: r.task,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          tokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
          errorMessage: r.errorMessage,
        })),
        scans: recentScans.map((s) => ({
          id: s.id,
          status: s.status,
          trigger: s.trigger,
          source: s.connection.source.name,
          createdAt: s.createdAt,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          itemsFound: s.itemsFound,
          itemsCreated: s.itemsCreated,
          itemsDeduped: s.itemsDeduped,
          errorMessage: s.errorMessage,
        })),
        goals: goals.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          updatedAt: g.updatedAt,
          subtasks: g.subtasks.length,
          subtasksDone: g.subtasks.filter((s) => s.status === 'COMPLETED').length,
        })),
      },
      social,
      redditScanAuth: redditConnector instanceof RedditConnector ? redditConnector.lastAuthMode : null,
      recovery: this.recovery.lastReport,
      events: events.map((e) => ({ id: e.id, level: e.level, action: e.action, message: e.message, createdAt: e.createdAt })),
    };
  }
}
