import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, VIEWER, agentIdByKey, createTestApp, loginAgent, resetDatabase } from './helpers';

describe('Auth, RBAC and safe errors (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
  });
  afterAll(async () => app.close());

  it('serves the public health check', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, /"status":"ok"/);
  });

  it('rejects unauthenticated access to everything else', async () => {
    for (const path of ['/api/tasks', '/api/agents', '/api/departments', '/api/dashboard/metrics', '/api/audit-logs', '/api/system/status']) {
      const res = await request(app.getHttpServer()).get(path).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, message: 'Authentication required' });
      expect(res.body.requestId).toEqual(expect.any(String));
    }
  });

  it('rejects a forged bearer token', async () => {
    await request(app.getHttpServer()).get('/api/tasks').set('Authorization', 'Bearer not.a.jwt').expect(401);
  });

  it('gives the same generic error for a wrong password and an unknown email, and audits both', async () => {
    const wrong = await request(app.getHttpServer()).post('/api/auth/login').send({ email: CEO.email, password: 'nope-nope-nope' }).expect(401);
    const unknown = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'ghost@example.test', password: 'whatever-123' }).expect(401);
    expect(wrong.body.message).toBe('Invalid email or password');
    expect(unknown.body.message).toBe(wrong.body.message);

    const failures = await prisma.auditLog.findMany({ where: { action: 'auth.login_failed' } });
    expect(failures).toHaveLength(2);
    // Unknown addresses are masked; passwords are never logged.
    expect(JSON.stringify(failures)).not.toContain('nope-nope-nope');
    expect(JSON.stringify(failures)).toContain('gh***@example.test');
  });

  it('logs in with an httpOnly SameSite=Strict cookie and never returns the token in the body', async () => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email: '  CEO@Example.TEST ', password: CEO.password }).expect(200);
    expect(res.body).toEqual({ user: expect.objectContaining({ email: CEO.email, role: 'CEO' }) });
    expect(JSON.stringify(res.body)).not.toMatch(/token|password/i);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
    expect(cookie).toMatch(/aic_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('returns the current user and logs out', async () => {
    const agent = await loginAgent(app, CEO);
    await agent.get('/api/auth/me').expect(200).expect((r) => expect(r.body.user.role).toBe('CEO'));
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('immediately locks out a deactivated user even with a valid session', async () => {
    const agent = await loginAgent(app, VIEWER);
    await agent.get('/api/auth/me').expect(200);
    await prisma.user.update({ where: { email: VIEWER.email }, data: { isActive: false } });
    await agent.get('/api/auth/me').expect(401);
    await prisma.user.update({ where: { email: VIEWER.email }, data: { isActive: true } });
  });

  describe('viewer role is read-only', () => {
    it('can read but cannot create, change tasks or configure agents', async () => {
      const viewer = await loginAgent(app, VIEWER);
      await viewer.get('/api/tasks').expect(200);
      await viewer.get('/api/agents').expect(200);
      await viewer.post('/api/tasks').send({ title: 'Viewer task' }).expect(403);
      const gm = await agentIdByKey(prisma, 'general_manager');
      await viewer.patch(`/api/agents/${gm}`).send({ isEnabled: false }).expect(403);
      await viewer.put(`/api/agents/${gm}/permissions`).send({ permissions: [] }).expect(403);
      await viewer.get('/api/audit-logs').expect(403);
    });
  });

  it('rejects unknown fields and malformed IDs with 400, without leaking internals', async () => {
    const agent = await loginAgent(app, CEO);
    const res = await agent.post('/api/tasks').send({ title: 'Valid title', isAdmin: true }).expect(400);
    expect(res.body.message).toContain('property isAdmin should not exist');
    await agent.get('/api/tasks/not-a-uuid').expect(400);
    const missing = await agent.get('/api/tasks/00000000-0000-4000-8000-000000000000').expect(404);
    expect(JSON.stringify(missing.body)).not.toMatch(/prisma|select|stack/i);
  });

  it('exposes AI configuration status without secrets', async () => {
    const agent = await loginAgent(app, CEO);
    const res = await agent.get('/api/system/status').expect(200);
    expect(res.body.ai).toEqual({ provider: 'openai', apiKeyConfigured: false, routineModel: null, advancedModel: null });
    expect(res.body.sources.map((s: { key: string }) => s.key)).toContain('manual_import');
  });
});
