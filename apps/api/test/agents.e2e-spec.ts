import { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, agentIdByKey, createTestApp, loginAgent, resetDatabase } from './helpers';

describe('Departments and agent definitions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: TestAgent;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    ceo = await loginAgent(app, CEO);
  });
  afterAll(async () => app.close());

  it('lists Sales and Marketing, each with a manager and six workers', async () => {
    const res = await ceo.get('/api/departments').expect(200);
    expect(res.body.map((d: { key: string }) => d.key)).toEqual(['sales', 'marketing']);
    for (const d of res.body) {
      expect(d.manager.kind).toBe('MANAGER');
      expect(d.workerCount).toBe(6);
      expect(d.taskStats).toEqual({ open: 0, completed: 0, failed: 0 });
    }
    await ceo.get('/api/departments/sales').expect(200).expect((r) => expect(r.body.name).toBe('Sales'));
  });

  it('builds the org chart CEO → GM → managers → workers', async () => {
    const res = await ceo.get('/api/departments/org-chart').expect(200);
    expect(res.body.root).toHaveLength(1);
    const gm = res.body.root[0];
    expect(gm.kind).toBe('GENERAL_MANAGER');
    expect(gm.children.map((c: { key: string }) => c.key)).toEqual(['sales_manager', 'marketing_manager']);
    for (const m of gm.children) expect(m.children).toHaveLength(6);
  });

  it('returns agent detail with permissions and the tool registry', async () => {
    const id = await agentIdByKey(prisma, 'content_writing_worker');
    const res = await ceo.get(`/api/agents/${id}`).expect(200);
    expect(res.body.parent.key).toBe('marketing_manager');
    // publishing is approval-locked
    expect(res.body.permissions).toContainEqual({ permission: 'content.publish', requiresApproval: true });
    const reg = await ceo.get('/api/agents/registry').expect(200);
    expect(reg.body.tools.length).toBeGreaterThan(10);
    expect(reg.body.permissions.find((p: { key: string }) => p.key === 'deals.confirm').agentGrantable).toBe(false);
  });

  it('lets the CEO edit instructions and model settings, with an audit trail', async () => {
    const id = await agentIdByKey(prisma, 'outreach_writing_worker');
    const instructions = 'Write short, specific messages that reference the prospect request. Never exaggerate.';
    const res = await ceo.patch(`/api/agents/${id}`).send({ instructions, modelTier: 'ADVANCED', maxOutputTokens: 1500 }).expect(200);
    expect(res.body).toMatchObject({ instructions, modelTier: 'ADVANCED', maxOutputTokens: 1500 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'agent.update', entityId: id } });
    expect((log.data as { fields: string[] }).fields.sort()).toEqual(['instructions', 'maxOutputTokens', 'modelTier']);
  });

  it('rejects unknown tools and tools whose permission is not granted', async () => {
    const id = await agentIdByKey(prisma, 'market_research_worker');
    const unknown = await ceo.patch(`/api/agents/${id}`).send({ tools: ['run_shell_command'] }).expect(400);
    expect(unknown.body.message).toMatch(/Unknown tools: run_shell_command/);
    const missing = await ceo.patch(`/api/agents/${id}`).send({ tools: ['save_lead'] }).expect(400);
    expect(missing.body.message).toMatch(/save_lead \(needs leads.write\)/);
  });

  it('rejects an invalid model ID override', async () => {
    const id = await agentIdByKey(prisma, 'market_research_worker');
    await ceo.patch(`/api/agents/${id}`).send({ modelOverride: 'gpt; DROP TABLE' }).expect(400);
    await ceo.patch(`/api/agents/${id}`).send({ modelOverride: null }).expect(200);
  });

  describe('permissions', () => {
    it('never grants human-only permissions to an agent (the GM cannot be given permission management)', async () => {
      const gm = await agentIdByKey(prisma, 'general_manager');
      const res = await ceo
        .put(`/api/agents/${gm}/permissions`)
        .send({ permissions: [{ permission: 'permissions.manage', requiresApproval: true }] })
        .expect(400);
      expect(res.body.message).toMatch(/only be held by people/);
      await ceo.put(`/api/agents/${gm}/permissions`).send({ permissions: [{ permission: 'deals.confirm', requiresApproval: true }] }).expect(400);
    });

    it('forces approval on sensitive permissions even if the request turns it off', async () => {
      const id = await agentIdByKey(prisma, 'outreach_writing_worker');
      const current = (await ceo.get(`/api/agents/${id}`).expect(200)).body.permissions as { permission: string; requiresApproval: boolean }[];
      const res = await ceo
        .put(`/api/agents/${id}/permissions`)
        .send({ permissions: [...current, { permission: 'outreach.send', requiresApproval: false }] })
        .expect(200);
      expect(res.body.permissions).toContainEqual({ permission: 'outreach.send', requiresApproval: true });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'agent.permissions.set', entityId: id } });
      expect(log.actorUserId).toEqual(expect.any(String));
    });

    it('refuses to remove a permission a configured tool depends on', async () => {
      const id = await agentIdByKey(prisma, 'lead_research_worker');
      const res = await ceo.put(`/api/agents/${id}/permissions`).send({ permissions: [{ permission: 'tasks.read', requiresApproval: false }] }).expect(400);
      expect(res.body.message).toMatch(/Remove these tools first/);
    });

    it('rejects unknown and duplicate permissions', async () => {
      const id = await agentIdByKey(prisma, 'lead_research_worker');
      await ceo.put(`/api/agents/${id}/permissions`).send({ permissions: [{ permission: 'db.raw_sql', requiresApproval: false }] }).expect(400);
      await ceo
        .put(`/api/agents/${id}/permissions`)
        .send({ permissions: [{ permission: 'tasks.read', requiresApproval: false }, { permission: 'tasks.read', requiresApproval: false }] })
        .expect(400);
    });
  });
});
