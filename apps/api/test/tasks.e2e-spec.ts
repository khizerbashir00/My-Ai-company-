import { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, agentIdByKey, createTestApp, loginAgent, resetDatabase } from './helpers';

describe('Tasks and the task state machine (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: TestAgent;
  let salesManager: string;
  let leadResearch: string;
  let marketingDept: string;

  const create = (body: Record<string, unknown>, status = 201) => ceo.post('/api/tasks').send(body).expect(status).then((r) => r.body);
  const move = (id: string, to: string, message?: string, status = 200) =>
    ceo.post(`/api/tasks/${id}/transition`).send({ to, ...(message && { message }) }).expect(status).then((r) => r.body);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    ceo = await loginAgent(app, CEO);
    salesManager = await agentIdByKey(prisma, 'sales_manager');
    leadResearch = await agentIdByKey(prisma, 'lead_research_worker');
    marketingDept = (await prisma.department.findUniqueOrThrow({ where: { key: 'marketing' } })).id;
  });
  afterAll(async () => app.close());

  describe('creation', () => {
    it('derives kind and department from the assigned agent and records history + audit', async () => {
      const { task, deduplicated } = await create({ title: 'Find US businesses requesting websites', assignedAgentId: salesManager, priority: 'HIGH' });
      expect(deduplicated).toBe(false);
      expect(task).toMatchObject({ kind: 'DEPARTMENT_TASK', status: 'QUEUED', priority: 'HIGH', attempts: 0, maxAttempts: 3 });
      expect(task.department.key).toBe('sales');
      expect(task.events).toHaveLength(1);
      expect(task.events[0]).toMatchObject({ type: 'created', toStatus: 'QUEUED', actorType: 'USER' });
      expect(await prisma.auditLog.count({ where: { action: 'task.create', entityId: task.id } })).toBe(1);
    });

    it('creates a CEO goal when nothing is assigned', async () => {
      const { task } = await create({ title: 'Grow e-commerce pipeline this quarter' });
      expect(task.kind).toBe('GOAL');
      expect(task.department).toBeNull();
    });

    it('returns the existing task for a repeated idempotency key instead of duplicating work', async () => {
      const body = { title: 'Weekly competitor scan', departmentId: marketingDept, idempotencyKey: 'weekly-competitor-scan-2026-w42' };
      const first = await create(body, 201);
      const second = await create(body, 200);
      expect(second.deduplicated).toBe(true);
      expect(second.task.id).toBe(first.task.id);
      expect(await prisma.task.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);
    });

    it('rejects inconsistent assignments', async () => {
      const salesDept = (await prisma.department.findUniqueOrThrow({ where: { key: 'sales' } })).id;
      await create({ title: 'Wrong dept', assignedAgentId: leadResearch, departmentId: marketingDept }, 400);
      await create({ title: 'Worker task w/o worker', kind: 'WORKER_TASK', departmentId: salesDept }, 400);
      await create({ title: 'Kind mismatch', kind: 'GOAL', assignedAgentId: leadResearch }, 400);
      await create({ title: 'Missing dep', dependsOn: ['00000000-0000-4000-8000-000000000000'] }, 400);
    });

    it('refuses to assign work to a disabled agent', async () => {
      const id = await agentIdByKey(prisma, 'competitor_analysis_worker');
      await prisma.agentDefinition.update({ where: { id }, data: { isEnabled: false } });
      const res = await create({ title: 'Compare agencies', assignedAgentId: id }, 400);
      expect(res.message).toMatch(/disabled/);
      await prisma.agentDefinition.update({ where: { id }, data: { isEnabled: true } });
    });
  });

  describe('state machine', () => {
    it('runs the full lifecycle with attempts, timestamps and events', async () => {
      const { task } = await create({ title: 'Qualify imported leads', assignedAgentId: salesManager });
      const running = await move(task.id, 'RUNNING');
      expect(running).toMatchObject({ status: 'RUNNING', attempts: 1 });
      expect(running.startedAt).toBeTruthy();
      await move(task.id, 'AWAITING_APPROVAL', 'Needs CEO sign-off on outreach');
      await move(task.id, 'RUNNING');
      const done = await move(task.id, 'COMPLETED');
      expect(done.completedAt).toBeTruthy();
      expect(done.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'RUNNING', 'COMPLETED']);
      // Terminal: no further moves or edits
      await move(task.id, 'RUNNING', undefined, 400);
      await ceo.patch(`/api/tasks/${task.id}`).send({ title: 'Edited after completion' }).expect(400);
    });

    it('rejects illegal jumps', async () => {
      const { task } = await create({ title: 'Illegal jump test' });
      const res = await move(task.id, 'COMPLETED', undefined, 400);
      expect(res.message).toBe('Cannot move a task from QUEUED to COMPLETED');
    });

    it('requires a reason to fail, stores it, and enforces the retry limit', async () => {
      const { task } = await create({ title: 'Flaky source scan', maxAttempts: 2 });
      await move(task.id, 'RUNNING');
      await move(task.id, 'FAILED', undefined, 400);
      const failed = await move(task.id, 'FAILED', 'Source returned HTTP 503');
      expect(failed.errorMessage).toBe('Source returned HTTP 503');

      const retried = await move(task.id, 'QUEUED');
      expect(retried.events.at(-1).type).toBe('retry');
      await move(task.id, 'RUNNING'); // attempt 2
      await move(task.id, 'FAILED', 'Still failing');
      const blocked = await move(task.id, 'QUEUED', undefined, 400);
      expect(blocked.message).toMatch(/Retry limit reached \(2\/2\)/);

      // The CEO can raise the limit (never below attempts already made) and retry.
      await ceo.patch(`/api/tasks/${task.id}`).send({ maxAttempts: 1 }).expect(400);
      await ceo.patch(`/api/tasks/${task.id}`).send({ maxAttempts: 3 }).expect(200);
      await move(task.id, 'QUEUED');
    });

    it('blocks starting a task until its dependencies are completed', async () => {
      const a = (await create({ title: 'Research dental clinics' })).task;
      const b = (await create({ title: 'Write campaign proposal', dependsOn: [a.id] })).task;
      expect(b.dependencies[0].dependsOn.id).toBe(a.id);
      const res = await move(b.id, 'RUNNING', undefined, 400);
      expect(res.message).toMatch(/1 unfinished dependency/);
      await move(a.id, 'RUNNING');
      await move(a.id, 'COMPLETED');
      await move(b.id, 'RUNNING');
    });

    it('cancels all unfinished subtasks when a parent is cancelled', async () => {
      const parent = (await create({ title: 'Parent goal' })).task;
      const child = (await create({ title: 'Child task', parentTaskId: parent.id, assignedAgentId: salesManager })).task;
      const grandchild = (await create({ title: 'Grandchild task', parentTaskId: child.id, assignedAgentId: leadResearch })).task;
      const doneChild = (await create({ title: 'Already done child', parentTaskId: parent.id })).task;
      await move(doneChild.id, 'RUNNING');
      await move(doneChild.id, 'COMPLETED');

      await move(parent.id, 'CANCELLED', 'Goal dropped');
      const statuses = await prisma.task.findMany({ where: { id: { in: [child.id, grandchild.id, doneChild.id] } }, select: { id: true, status: true } });
      const byId = Object.fromEntries(statuses.map((s) => [s.id, s.status]));
      expect(byId[child.id]).toBe('CANCELLED');
      expect(byId[grandchild.id]).toBe('CANCELLED');
      expect(byId[doneChild.id]).toBe('COMPLETED');
      await create({ title: 'Too late', parentTaskId: parent.id }, 400);
    });

    it('detects a concurrent change (compare-and-set)', async () => {
      const { task } = await create({ title: 'Race test' });
      const [a, b] = await Promise.all([
        ceo.post(`/api/tasks/${task.id}/transition`).send({ to: 'RUNNING' }),
        ceo.post(`/api/tasks/${task.id}/transition`).send({ to: 'CANCELLED' }),
      ]);
      const codes = [a.status, b.status].sort();
      // Exactly one wins; the other is rejected as a conflict or an now-illegal transition.
      expect(codes[0]).toBe(200);
      expect([400, 409]).toContain(codes[1]);
      expect(await prisma.taskEvent.count({ where: { taskId: task.id, type: 'status_changed' } })).toBe(1);
    });
  });

  describe('listing', () => {
    it('filters, searches, sorts and paginates', async () => {
      const byStatus = await ceo.get('/api/tasks?status=COMPLETED,CANCELLED&pageSize=100').expect(200);
      expect(byStatus.body.items.every((t: { status: string }) => ['COMPLETED', 'CANCELLED'].includes(t.status))).toBe(true);

      const search = await ceo.get('/api/tasks?search=DENTAL').expect(200);
      expect(search.body.items.map((t: { title: string }) => t.title)).toEqual(['Research dental clinics']);

      const roots = await ceo.get('/api/tasks?parentTaskId=root&pageSize=100').expect(200);
      expect(roots.body.items.every((t: { parentTaskId: string | null }) => t.parentTaskId === null)).toBe(true);

      const byDept = await ceo.get(`/api/tasks?departmentId=${marketingDept}`).expect(200);
      expect(byDept.body.items.every((t: { department: { key: string } }) => t.department.key === 'marketing')).toBe(true);

      const total = (await ceo.get('/api/tasks?pageSize=100').expect(200)).body.total;
      const p1 = await ceo.get('/api/tasks?pageSize=3&page=1&sortBy=title&sortDir=asc').expect(200);
      const p2 = await ceo.get('/api/tasks?pageSize=3&page=2&sortBy=title&sortDir=asc').expect(200);
      expect(p1.body).toMatchObject({ total, page: 1, pageSize: 3, totalPages: Math.ceil(total / 3) });
      const titles = [...p1.body.items, ...p2.body.items].map((t: { title: string }) => t.title);
      expect(titles).toEqual([...titles].sort((x, y) => x.localeCompare(y, 'en', { sensitivity: 'base' }) || 0));
      expect(new Set(titles).size).toBe(6);

      await ceo.get('/api/tasks?sortBy=password').expect(400);
      await ceo.get('/api/tasks?status=DONE').expect(400);
      await ceo.get('/api/tasks?pageSize=1000').expect(400);
    });
  });
});
