import { INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type TestAgent from 'supertest/lib/agent';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, createTestApp, loginAgent, nextClientIp, resetDatabase } from './helpers';

describe('Dashboard metrics and live events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: TestAgent;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    ceo = await loginAgent(app, CEO);
  });
  afterAll(async () => app.close());

  it('reports zeros — not placeholder numbers — on an empty database', async () => {
    const { body } = await ceo.get('/api/dashboard/metrics').expect(200);
    expect(body.sales).toMatchObject({ leadsTotal: 0, leadsQualified: 0, messagesSent: 0, dealsWon: 0, revenue: [] });
    expect(body.tasks.completionRate).toBeNull();
    expect(body.marketing.performance.measured).toBe(false);
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
    await mkLead('cold', { intentLabel: 'LOW', latestScore: 20, stage: 'LOST', lostAt: new Date() });
    await mkLead('other-source', { intentLabel: 'HIGH', stage: 'NEW' }, other.id);
    await mkLead('last-year', { intentLabel: 'HIGH', stage: 'QUALIFIED' }, manual.id, old);

    const msg = await prisma.outreachMessage.create({ data: { leadId: hot.id, channel: 'EMAIL', body: 'Hi', status: 'SENT', sentAt: new Date() } });
    await prisma.outreachMessage.create({ data: { leadId: hot.id, channel: 'EMAIL', body: 'Follow-up', status: 'DRAFT' } });
    await prisma.outreachEvent.createMany({
      data: [
        { leadId: hot.id, messageId: msg.id, type: 'REPLY_RECEIVED' },
        { leadId: hot.id, messageId: msg.id, type: 'REPLY_RECEIVED' }, // same lead twice → counted once
      ],
    });
    await prisma.project.create({ data: { leadId: hot.id, name: 'Clinic site', dealValue: '4500.00', currency: 'USD' } });
    await prisma.approval.create({ data: { actionType: 'SEND_EXTERNAL_MESSAGE', entityType: 'outreach_message', summary: 'Send follow-up' } });
    const t1 = await prisma.task.create({ data: { title: 'done', status: 'COMPLETED' } });
    await prisma.task.create({ data: { title: 'failed', status: 'FAILED' } });
    await prisma.task.create({ data: { title: 'queued', status: 'QUEUED' } });

    const all = (await ceo.get('/api/dashboard/metrics').expect(200)).body;
    expect(all.sales).toMatchObject({
      leadsTotal: 5,
      leadsQualified: 4, // hot, warm, other-source, last-year
      leadsHighIntent: 3,
      outreachDrafts: 1,
      messagesSent: 1,
      repliesReceived: 1,
      interestedProspects: 2, // warm (INTERESTED) + hot (DEMO_REQUESTED)
      demoRequests: 1,
      meetingsScheduled: 1,
      dealsWon: 1,
      dealsLost: 1,
      revenue: [{ currency: 'USD', amount: '4500.00', deals: 1 }],
    });
    expect(all.tasks).toMatchObject({ total: 3, failed: 1, pendingApprovals: 1, completionRate: 0.5 });
    expect(all.tasks.recent.map((t: { id: string }) => t.id)).toContain(t1.id);

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const recent = (await ceo.get(`/api/dashboard/metrics?from=${from}`).expect(200)).body;
    expect(recent.sales.leadsTotal).toBe(4); // excludes last-year

    const onlyOther = (await ceo.get(`/api/dashboard/metrics?sourceId=${other.id}`).expect(200)).body;
    expect(onlyOther.sales).toMatchObject({ leadsTotal: 1, leadsHighIntent: 1, messagesSent: 0, dealsWon: 0 });

    await ceo.get(`/api/dashboard/metrics?from=2026-02-01&to=2026-01-01`).expect(400);
  });

  it('streams task events over SSE to an authenticated client', async () => {
    const server = app.getHttpServer() as http.Server;
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    // Reuse a real session cookie
    const login = await ceo.post('/api/auth/login').set('X-Forwarded-For', nextClientIp()).send({ email: CEO.email, password: CEO.password });
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;

    // Unauthenticated stream is refused
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
        // Once connected, create a task through the API
        setTimeout(() => void ceo.post('/api/tasks').send({ title: 'Live update check' }).catch(reject), 100);
      });
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      setTimeout(() => reject(new Error('No SSE event within 5s')), 5000);
    });
    const payload = await received;
    expect(payload).toMatch(/"type":"task.created"/);
    expect(payload).toMatch(/"status":"QUEUED"/);
  });
});
