import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AiCancelledError } from '../src/ai/ai.errors';
import { FakeAiProvider } from '../src/ai/fake-ai.provider';
import type { AgentTurn } from '../src/ai/schemas';
import { AiTaskWorkerService } from '../src/control/ai-task-worker.service';
import { WorkflowStateService } from '../src/control/control-core';
import { INTERRUPTED_MESSAGE, RecoveryService } from '../src/control/recovery.service';
import { STOPPED_BY_CONTROL_MESSAGE } from '../src/orchestration/task-runner.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScanSchedulerService } from '../src/sources/scan-scheduler.service';
import { agentIdByKey, CEO, createTestApp, loginAgent, resetDatabase, VIEWER } from './helpers';

const workerTurn = (summary: string): AgentTurn => ({
  notes: 'Done',
  plan: null,
  result: { summary, outcome: 'completed', findings: [], blockedReasons: [], nextActions: [] },
  toolRequests: [],
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for condition');
}

describe('Control Center (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeAi: FakeAiProvider;
  let worker: AiTaskWorkerService;
  let ceo: Awaited<ReturnType<typeof loginAgent>>;
  let researchWorkerId: string;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'test-key-not-sent-anywhere';
    process.env.OPENAI_MODEL = 'gpt-test-routine';
    fakeAi = new FakeAiProvider();
    ({ app, prisma } = await createTestApp({ fakeAi }));
    worker = app.get(AiTaskWorkerService);
  });

  afterAll(async () => {
    await app.close();
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_MODEL = '';
  });

  beforeEach(async () => {
    // Make sure nothing from a previous test is still executing before the tables are truncated.
    worker.abortCurrent();
    await worker.idle();
    await resetDatabase(prisma);
    await app.get(RecoveryService).recover();
    await app.get(WorkflowStateService).reload();
    fakeAi.clear();
    ceo = await loginAgent(app, CEO);
    researchWorkerId = await agentIdByKey(prisma, 'lead_research_worker');
  });

  async function queueWorkerTask(title: string, extra: Record<string, unknown> = {}) {
    const res = await ceo.post('/api/tasks').send({ title, description: 'Control Center test', assignedAgentId: researchWorkerId, ...extra }).expect(201);
    return res.body.task.id as string;
  }

  it('status reports workflows, agents, people, jobs and social connections', async () => {
    const res = await ceo.get('/api/control/status').expect(200);
    expect(res.body.workflows.map((w: { key: string }) => w.key)).toEqual(['ai-task-worker', 'lead-source-scans', 'outreach-follow-ups']);
    const byKey = Object.fromEntries(res.body.workflows.map((w: { key: string; enabled: boolean; state: string }) => [w.key, w]));
    // Defaults preserve pre-existing behavior: schedulers on, AI worker off until Start.
    expect(byKey['ai-task-worker'].enabled).toBe(false);
    expect(byKey['ai-task-worker'].state).toBe('stopped');
    expect(byKey['lead-source-scans'].enabled).toBe(true);
    expect(res.body.agents).toHaveLength(15);
    expect(res.body.agents.every((a: { state: string }) => a.state === 'idle')).toBe(true);
    expect(res.body.people.map((p: { role: string }) => p.role).sort()).toEqual(['CEO', 'VIEWER']);
    expect(res.body.people[0]).not.toHaveProperty('email');
    expect(res.body.social).toHaveLength(4);
    expect(res.body.ai.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-sent-anywhere');
  });

  it('viewers can watch but not operate', async () => {
    const viewer = await loginAgent(app, VIEWER);
    await viewer.get('/api/control/status').expect(200);
    for (const path of ['start-all', 'stop-all', 'restart-failed', 'workflows/ai-task-worker/start']) {
      await viewer.post(`/api/control/${path}`).send({}).expect(403);
    }
    await request(app.getHttpServer()).get('/api/control/status').expect(401);
    await ceo.post('/api/control/workflows/not-a-workflow/start').send({}).expect(400);
  });

  it('Start All runs queued agent work for real: tasks complete, runs and usage are recorded', async () => {
    const a = await queueWorkerTask('Research agencies in Lahore');
    const b = await queueWorkerTask('Research agencies in Karachi', { priority: 'URGENT' });
    // A task whose agent is disabled is not eligible.
    const qualId = await agentIdByKey(prisma, 'lead_qualification_worker');
    const disabledTask = (await ceo.post('/api/tasks').send({ title: 'Qualify a lead', assignedAgentId: qualId }).expect(201)).body.task.id;
    await prisma.agentDefinition.update({ where: { id: qualId }, data: { isEnabled: false } });

    const seen: string[] = [];
    fakeAi.setHandler(async (req) => {
      const user = req.messages.find((m) => m.role === 'user')!.content;
      seen.push(user.includes('Karachi') ? 'karachi' : 'lahore');
      return { data: workerTurn('Found 0 verified leads; nothing invented.'), model: req.model, provider: 'openai', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, rawText: '' };
    });

    const res = await ceo.post('/api/control/start-all').send({}).expect(200);
    expect(res.body.ok).toBe(true);
    const workerItem = res.body.items.find((i: { target: string }) => i.target === 'ai-task-worker');
    expect(workerItem.message).toContain('2 eligible queued task(s)');
    expect((await prisma.workflowControl.findUnique({ where: { key: 'ai-task-worker' } }))?.isEnabled).toBe(true);

    await worker.idle();
    expect(seen).toEqual(['karachi', 'lahore']); // URGENT first
    for (const id of [a, b]) {
      const t = await prisma.task.findUniqueOrThrow({ where: { id } });
      expect(t.status).toBe('COMPLETED');
      expect(await prisma.agentRun.count({ where: { taskId: id, status: 'SUCCEEDED' } })).toBe(1);
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: disabledTask } })).status).toBe('QUEUED');
    expect(await prisma.usageRecord.count()).toBe(2);
    expect(await prisma.controlEvent.count({ where: { action: 'worker.task_completed' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'control.start_all' } })).toBe(1);

    const status = await ceo.get('/api/control/status').expect(200);
    const rw = status.body.agents.find((x: { key: string }) => x.key === 'lead_research_worker');
    expect(rw.tasks.completedToday).toBe(2);
    expect(rw.lastRun.status).toBe('SUCCEEDED');
    expect(status.body.jobs.agentRuns).toHaveLength(2);
  });

  it('Stop All aborts the in-flight AI call, records it as retryable, and keeps everything stopped', async () => {
    const id = await queueWorkerTask('Long running research');
    let started = false;
    fakeAi.setHandler(
      (req) =>
        new Promise((_, reject) => {
          started = true;
          req.signal?.addEventListener('abort', () => reject(new AiCancelledError()), { once: true });
        }),
    );

    await ceo.post('/api/control/start-all').send({}).expect(200);
    await waitFor(async () => started && (await prisma.task.findUniqueOrThrow({ where: { id } })).status === 'RUNNING');
    expect(worker.snapshot().current?.taskId).toBe(id);

    const stop = await ceo.post('/api/control/stop-all').send({}).expect(200);
    expect(stop.body.ok).toBe(true);
    expect(stop.body.items.find((i: { target: string }) => i.target === 'ai-task-worker').message).toContain('aborted');

    const task = await prisma.task.findUniqueOrThrow({ where: { id } });
    expect(task.status).toBe('FAILED');
    expect(task.errorMessage).toBe(STOPPED_BY_CONTROL_MESSAGE);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { taskId: id } });
    expect(run.status).toBe('FAILED');
    expect(worker.snapshot().busy).toBe(false);
    const rows = await prisma.workflowControl.findMany();
    expect(rows.map((r) => [r.key, r.isEnabled]).sort()).toEqual([
      ['ai-task-worker', false],
      ['lead-source-scans', false],
      ['outreach-follow-ups', false],
    ]);

    // While stopped, new work is not picked up.
    fakeAi.setHandler(async (req) => ({ data: workerTurn('should not run'), model: req.model, provider: 'openai', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, rawText: '' }));
    const later = await queueWorkerTask('Queued after stop');
    worker.kick();
    await worker.idle();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: later } })).status).toBe('QUEUED');
    // The scan scheduler respects the switch too.
    expect(await app.get(ScanSchedulerService).tick()).toBe(0);
  });

  it('Restart Failed re-queues retryable tasks (and explains the rest), then Start All finishes them', async () => {
    const retryable = await queueWorkerTask('Retryable');
    const exhausted = await queueWorkerTask('Exhausted', { maxAttempts: 1 });
    for (const id of [retryable, exhausted]) {
      await ceo.post(`/api/tasks/${id}/transition`).send({ to: 'RUNNING' }).expect(200);
      await ceo.post(`/api/tasks/${id}/transition`).send({ to: 'FAILED', message: 'Provider timeout' }).expect(200);
    }

    const res = await ceo.post('/api/control/restart-failed').send({}).expect(200);
    const tasksItem = res.body.items.find((i: { target: string }) => i.target === 'tasks');
    expect(tasksItem.message).toContain('1 of 2 failed task(s) re-queued');
    expect(tasksItem.message).toContain('retry limit reached');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: retryable } })).status).toBe('QUEUED');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: exhausted } })).status).toBe('FAILED');
    const ev = await prisma.taskEvent.findFirst({ where: { taskId: retryable, toStatus: 'QUEUED', fromStatus: 'FAILED' } });
    expect(ev?.message).toContain('Restart Failed');

    fakeAi.setHandler(async (req) => ({ data: workerTurn('Retried OK'), model: req.model, provider: 'openai', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, rawText: '' }));
    await ceo.post('/api/control/start-all').send({}).expect(200);
    await worker.idle();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: retryable } })).status).toBe('COMPLETED');
  });

  it('a blocked agent result is logged as a warning and the worker moves on', async () => {
    const id = await queueWorkerTask('Needs a connector we do not have');
    fakeAi.setHandler(async (req) => ({
      data: { ...workerTurn('Blocked'), result: { summary: 'Blocked', outcome: 'blocked', findings: [], blockedReasons: ['No authorized connector for that site'], nextActions: [] } },
      model: req.model,
      provider: 'openai',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      rawText: '',
    }));
    await ceo.post('/api/control/workflows/ai-task-worker/start').send({}).expect(200);
    await worker.idle();
    const t = await prisma.task.findUniqueOrThrow({ where: { id } });
    expect(t.status).toBe('FAILED');
    expect(t.errorMessage).toContain('No authorized connector');
    expect(await prisma.controlEvent.count({ where: { action: 'worker.task_blocked', level: 'WARN' } })).toBe(1);
  });

  it('startup recovery fails orphaned RUNNING work so it can be retried (crash/redeploy bug fix)', async () => {
    const id = await queueWorkerTask('Was running when the server died');
    await ceo.post(`/api/tasks/${id}/transition`).send({ to: 'RUNNING' }).expect(200);
    await prisma.agentRun.create({ data: { taskId: id, agentId: researchWorkerId, status: 'RUNNING', provider: 'openai', model: 'x' } });
    const conn = await prisma.sourceConnection.findFirstOrThrow({ where: { source: { key: 'hacker_news' } } });
    const scan = await prisma.sourceScanRun.create({ data: { connectionId: conn.id, status: 'RUNNING', trigger: 'SCHEDULE', startedAt: new Date() } });

    const report = await app.get(RecoveryService).recover();
    expect(report).toEqual({ agentRunsFailed: 1, tasksFailed: 1, scanRunsFailed: 1, scanRunsRequeued: 0 });

    const task = await prisma.task.findUniqueOrThrow({ where: { id } });
    expect(task.status).toBe('FAILED');
    expect(task.errorMessage).toBe(INTERRUPTED_MESSAGE);
    expect((await prisma.sourceScanRun.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe('FAILED');
    const hist = await prisma.taskEvent.findFirst({ where: { taskId: id, toStatus: 'FAILED' } });
    expect(hist?.actorType).toBe('SYSTEM');
    expect(await prisma.controlEvent.count({ where: { action: 'recovery.completed' } })).toBe(1);

    // And it is now retryable through Restart Failed (before the fix it was stuck forever).
    await ceo.post('/api/control/restart-failed').send({}).expect(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).status).toBe('QUEUED');
  });

  it('individual workflow switches persist and are reflected in status', async () => {
    await ceo.post('/api/control/workflows/outreach-follow-ups/stop').send({}).expect(200);
    let st = await ceo.get('/api/control/status').expect(200);
    expect(st.body.workflows.find((w: { key: string }) => w.key === 'outreach-follow-ups').state).toBe('stopped');
    await ceo.post('/api/control/workflows/outreach-follow-ups/start').send({}).expect(200);
    st = await ceo.get('/api/control/status').expect(200);
    expect(st.body.workflows.find((w: { key: string }) => w.key === 'outreach-follow-ups').enabled).toBe(true);
    expect(st.body.events.some((e: { action: string }) => e.action === 'control.workflow_stop')).toBe(true);
  });
});
