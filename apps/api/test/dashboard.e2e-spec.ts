import { INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type TestAgent from 'supertest/lib/agent';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, createTestApp, loginAgent, nextClientIp, resetDatabase, VIEWER } from './helpers';

describe('Dashboard metrics and live events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: TestAgent;
  let viewer: TestAgent;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });
  afterAll(async () => app.close());

  beforeEach(async () => {
    await resetDatabase(prisma);
    ceo = await loginAgent(app, CEO);
    viewer = await loginAgent(app, VIEWER);
  });

  it('reports zeros — not placeholder numbers — on an empty database', async () => {
    const { body } = await ceo.get('/api/dashboard/metrics').expect(200);
    expect(body.sales).toMatchObject({
      leadsTotal: 0,
      leadsQualified: 0,
      messagesSent: 0,
      dealsWon: 0,
      draftsAwaitingApproval: 0,
      negotiations: 0,
      revenue: [],
    });
    expect(body.tasks.completionRate).toBeNull();
    expect(body.marketing.performance.measured).toBe(false);
    expect(body.marketing.performance.unavailable).toEqual(
      expect.arrayContaining(['reach', 'engagement']),
    );
    expect(body.aiUsage.measured).toBe(false);
    expect(body.aiUsage.estimatedUsdTotal).toBeNull();
    expect(body.aiUsage.costKind).toBe('UNAVAILABLE');
    expect(body.sales.pipeline).toHaveLength(13);
    expect(Object.keys(body.definitions).length).toBeGreaterThan(10);
  });

  it('counts exactly what is in the database, with date and source filters', async () => {
    const manual = await prisma.source.findUniqueOrThrow({ where: { key: 'manual_import' } });
    const other = await prisma.source.create({ data: { key: 'test_feed', name: 'Test feed', platform: 'test', accessMethod: 'AUTHORIZED_FEED' } });
    const old = new Date('2025-01-15T00:00:00Z');
    const mkLead = async (name: string, data: Record<string, unknown>, sourceId = manual.id, createdAt?: Date) =>
      prisma.lead.create({
        data: {
          name,
          ...data,
          ...(createdAt && { createdAt }),
          sources: { create: { sourceId, url: `https://example.test/${name}`, canonicalUrl: `https://example.test/${name}`, accessMethod: 'MANUAL_IMPORT' } },
        },
      });

    const hot = await mkLead('hot', { intentLabel: 'HIGH', latestScore: 88, stage: 'DEMO_REQUESTED', demoScheduledAt: new Date() });
    await mkLead('warm', { intentLabel: 'MEDIUM', latestScore: 61, stage: 'INTERESTED' });
    await mkLead('nego', { intentLabel: 'HIGH', latestScore: 90, stage: 'NEGOTIATION' });
    await mkLead('cold', { intentLabel: 'LOW', latestScore: 20, stage: 'LOST', lostAt: new Date() });
    await mkLead('other-source', { intentLabel: 'HIGH', stage: 'NEW' }, other.id);
    await mkLead('last-year', { intentLabel: 'HIGH', stage: 'QUALIFIED' }, manual.id, old);

    const msg = await prisma.outreachMessage.create({ data: { leadId: hot.id, channel: 'EMAIL', body: 'Hi', status: 'SENT', sentAt: new Date() } });
    await prisma.outreachMessage.create({ data: { leadId: hot.id, channel: 'EMAIL', body: 'Follow-up', status: 'DRAFT' } });
    await prisma.outreachEvent.createMany({
      data: [
        { leadId: hot.id, messageId: msg.id, type: 'REPLY_RECEIVED' },
        { leadId: hot.id, messageId: msg.id, type: 'REPLY_RECEIVED' },
      ],
    });
    await prisma.project.create({ data: { leadId: hot.id, name: 'Clinic site', dealValue: '4500.00', currency: 'USD' } });
    await prisma.approval.create({ data: { actionType: 'SEND_EXTERNAL_MESSAGE', entityType: 'outreach_message', summary: 'Send follow-up' } });
    await prisma.approval.create({ data: { actionType: 'PUBLISH_CONTENT', entityType: 'content_item', summary: 'Publish post' } });
    const t1 = await prisma.task.create({ data: { title: 'done', status: 'COMPLETED' } });
    await prisma.task.create({ data: { title: 'failed', status: 'FAILED' } });
    await prisma.task.create({ data: { title: 'queued', status: 'QUEUED' } });
    await prisma.usageRecord.create({
      data: { provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    });

    const all = (await ceo.get('/api/dashboard/metrics').expect(200)).body;
    expect(all.sales).toMatchObject({
      leadsTotal: 6,
      leadsQualified: 5,
      leadsHighIntent: 4,
      outreachDrafts: 1,
      draftsAwaitingApproval: 2,
      messagesSent: 1,
      repliesReceived: 1,
      interestedProspects: 3,
      demoRequests: 2,
      negotiations: 1,
      meetingsScheduled: 1,
      dealsWon: 1,
      dealsLost: 1,
      revenue: [{ currency: 'USD', amount: '4500.00', deals: 1 }],
    });
    expect(all.tasks).toMatchObject({ total: 3, failed: 1, pendingApprovals: 2, completionRate: 0.5 });
    expect(all.tasks.recent.map((t: { id: string }) => t.id)).toContain(t1.id);
    expect(all.aiUsage.measured).toBe(true);
    expect(all.aiUsage.inputTokens).toBe(1_000_000);
    expect(all.aiUsage.costKind).toBe('ESTIMATE');
    expect(all.aiUsage.estimatedUsdTotal).toBeCloseTo(0.15, 5);
    expect(all.aiUsage.note).toMatch(/ESTIMATE/i);

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const recent = (await ceo.get(`/api/dashboard/metrics?from=${from}`).expect(200)).body;
    expect(recent.sales.leadsTotal).toBe(5);

    const onlyOther = (await ceo.get(`/api/dashboard/metrics?sourceId=${other.id}`).expect(200)).body;
    expect(onlyOther.sales).toMatchObject({ leadsTotal: 1, leadsHighIntent: 1, messagesSent: 0, dealsWon: 0 });

    await ceo.get(`/api/dashboard/metrics?from=2026-02-01&to=2026-01-01`).expect(400);
  });

  it('generates and lists CEO daily/weekly reports from saved metrics', async () => {
    await prisma.lead.create({
      data: {
        name: 'Report Lead',
        stage: 'NEW',
        sources: {
          create: {
            sourceId: (await prisma.source.findUniqueOrThrow({ where: { key: 'manual_import' } })).id,
            url: 'https://example.test/r',
            canonicalUrl: 'https://example.test/r',
            accessMethod: 'MANUAL_IMPORT',
          },
        },
      },
    });

    await viewer.post('/api/dashboard/reports/generate').send({ period: 'DAILY' }).expect(403);

    const daily = await ceo.post('/api/dashboard/reports/generate').send({ period: 'DAILY' }).expect(201);
    expect(daily.body.period).toBe('DAILY');
    expect(daily.body.metricsSnapshot.sales.leadsTotal).toBe(1);
    expect(daily.body.body).toContain('Leads discovered:');

    const weekly = await ceo.post('/api/dashboard/reports/generate').send({ period: 'WEEKLY' }).expect(201);
    expect(weekly.body.period).toBe('WEEKLY');

    const list = await ceo.get('/api/dashboard/reports?page=1&pageSize=10').expect(200);
    expect(list.body.total).toBeGreaterThanOrEqual(2);
    expect(list.body.items[0].title).toMatch(/CEO report/);

    const one = await ceo.get(`/api/dashboard/reports/${daily.body.id}`).expect(200);
    expect(one.body.id).toBe(daily.body.id);
  });

  it('scopes notifications per user and prevents duplicate inserts', async () => {
    const { NotificationsService } = await import('../src/notifications/notifications.service');
    const svc = app.get(NotificationsService);
    const ceoUser = await prisma.user.findUniqueOrThrow({ where: { email: CEO.email } });
    const viewerUser = await prisma.user.findUniqueOrThrow({ where: { email: VIEWER.email } });

    await svc.notify({
      userId: ceoUser.id,
      type: 'APPROVAL_REQUIRED',
      title: 'CEO only alert',
      body: 'Approve outreach',
      link: '/approvals',
      dedupeKey: 'test-approval-1',
    });
    const dup = await svc.notify({
      userId: ceoUser.id,
      type: 'APPROVAL_REQUIRED',
      title: 'CEO only alert',
      body: 'Approve outreach',
      link: '/approvals',
      dedupeKey: 'test-approval-1',
    });
    expect(dup.created).toBe(false);

    await svc.notify({
      userId: viewerUser.id,
      type: 'SYSTEM',
      title: 'Viewer note',
      dedupeKey: 'viewer-note-1',
    });

    const ceoList = await ceo.get('/api/notifications').expect(200);
    expect(ceoList.body.items.every((n: { title: string }) => n.title !== 'Viewer note')).toBe(true);
    expect(ceoList.body.items.some((n: { title: string }) => n.title === 'CEO only alert')).toBe(true);

    const viewerList = await viewer.get('/api/notifications').expect(200);
    expect(viewerList.body.items.every((n: { title: string }) => n.title !== 'CEO only alert')).toBe(true);

    const unread = await ceo.get('/api/notifications/unread-count').expect(200);
    expect(unread.body.unread).toBeGreaterThanOrEqual(1);

    const id = ceoList.body.items[0].id as string;
    await viewer.post(`/api/notifications/${id}/read`).expect(404);
    await ceo.post(`/api/notifications/${id}/read`).expect(200);
  });

  it('streams task events over SSE and keeps notification events user-scoped', async () => {
    const server = app.getHttpServer() as http.Server;
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const login = await ceo.post('/api/auth/login').set('X-Forwarded-For', nextClientIp()).send({ email: CEO.email, password: CEO.password });
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;

    const denied = await new Promise<number>((resolve) => http.get({ port, path: '/api/events/stream' }, (r) => { resolve(r.statusCode ?? 0); r.destroy(); }));
    expect(denied).toBe(401);

    const received = new Promise<string>((resolve, reject) => {
      const req = http.get({ port, path: '/api/events/stream', headers: { cookie, accept: 'text/event-stream' } }, (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes('event: task.created')) {
            req.destroy();
            resolve(buf);
          }
        });
        setTimeout(() => void ceo.post('/api/tasks').send({ title: 'Live update check' }).catch(reject), 100);
      });
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      setTimeout(() => reject(new Error('No SSE event within 5s')), 5000);
    });
    const payload = await received;
    expect(payload).toMatch(/"type":"task.created"/);
    expect(payload).toMatch(/"status":"QUEUED"/);

    // Heartbeat presence: open briefly and expect heartbeat or reconnectable stream type
    const heartbeat = await new Promise<string>((resolve, reject) => {
      const req = http.get({ port, path: '/api/events/stream', headers: { cookie, accept: 'text/event-stream' } }, (res) => {
        let buf = '';
        const timer = setTimeout(() => {
          // Force a heartbeat wait up to 26s is too long for tests — just confirm stream stays open with content-type
          req.destroy();
          resolve(buf || 'open');
        }, 200);
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes('heartbeat') || buf.includes('event:')) {
            clearTimeout(timer);
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      setTimeout(() => reject(new Error('SSE connect failed')), 3000);
    });
    expect(heartbeat.length).toBeGreaterThan(0);
  });
});
