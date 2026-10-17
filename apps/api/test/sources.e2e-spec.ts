import { INestApplication } from '@nestjs/common';
import { HN_SOURCE_KEY } from '../src/connectors/hacker-news/hn.connector';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, createTestApp, loginAgent, resetDatabase, VIEWER } from './helpers';

describe('Lead source connectors (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: Awaited<ReturnType<typeof loginAgent>>;
  let viewer: Awaited<ReturnType<typeof loginAgent>>;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ceo = await loginAgent(app, CEO);
    viewer = await loginAgent(app, VIEWER);
    global.fetch = originalFetch;
  });

  function mockHnFetch(hits: Array<Record<string, unknown>>) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        hits,
        page: 0,
        nbPages: 1,
        hitsPerPage: 20,
        nbHits: hits.length,
      }),
    }) as unknown as typeof fetch;
  }

  async function waitForScan(scanRunId: string, timeoutMs = 8_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const run = await prisma.sourceScanRun.findUnique({ where: { id: scanRunId } });
      if (run && (run.status === 'SUCCEEDED' || run.status === 'FAILED')) return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Scan ${scanRunId} did not finish`);
  }

  it('lists live connectors and import-only platforms without claiming LinkedIn/Facebook as scanning', async () => {
    const res = await ceo.get('/api/sources').expect(200);
    expect(res.body.jobsMode).toBe('inline');
    expect(res.body.implementedConnectors.map((c: { key: string }) => c.key).sort()).toEqual(
      [HN_SOURCE_KEY, 'reddit'].sort(),
    );
    const keys = res.body.items.map((s: { key: string }) => s.key);
    expect(keys).toContain('manual_import');
    expect(keys).toContain(HN_SOURCE_KEY);
    expect(keys).toContain('reddit');
    expect(keys).toContain('linkedin');
    expect(keys).toContain('facebook');
    expect(keys).toContain('indeed');

    const hn = res.body.items.find((s: { key: string }) => s.key === HN_SOURCE_KEY);
    expect(hn.displayStatus).toBe('CONFIGURED');
    expect(hn.implemented).toBe(true);
    expect(hn.authorized).toBe(true);
    expect(hn.permissions.canScan).toBe(true);

    for (const key of ['linkedin', 'facebook', 'indeed', 'manual_import']) {
      const row = res.body.items.find((s: { key: string }) => s.key === key);
      expect(row.displayStatus).toBe('MANUAL_FALLBACK');
      expect(row.permissions.canScan).toBe(false);
      expect(row.accessMethod).toBe('MANUAL_IMPORT');
    }
  });

  it('runs a mocked HN scan, creates leads with source evidence, and dedupes on repeat', async () => {
    mockHnFetch([
      {
        objectID: '424242',
        title: 'Ask HN: Need a TypeScript website rebuild',
        author: 'founder42',
        url: 'https://startup.example',
        created_at_i: 1_700_000_000,
        story_text: 'Looking for a developer for our marketing site.',
        _tags: ['ask_hn'],
      },
    ]);

    const list = await ceo.get('/api/sources').expect(200);
    const hn = list.body.items.find((s: { key: string }) => s.key === HN_SOURCE_KEY);
    const connectionId = hn.connection.id as string;

    const started = await ceo.post(`/api/sources/connections/${connectionId}/scan`).expect(202);
    expect(started.body.scanRunId).toBeTruthy();
    expect(started.body.jobsMode).toBe('inline');

    const run = await waitForScan(started.body.scanRunId);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.itemsCreated).toBe(1);
    expect(run.itemsDeduped).toBe(0);

    const lead = await prisma.lead.findFirst({
      where: { sources: { some: { externalId: '424242' } } },
      include: { sources: { include: { source: true } } },
    });
    expect(lead).toBeTruthy();
    expect(lead!.sources[0]!.source.key).toBe(HN_SOURCE_KEY);
    expect(lead!.sources[0]!.url).toBe('https://news.ycombinator.com/item?id=424242');
    expect(lead!.sources[0]!.accessMethod).toBe('OFFICIAL_API');

    const qualify = await prisma.task.findFirst({ where: { idempotencyKey: `qualify-lead:${lead!.id}` } });
    expect(qualify).toBeTruthy();

    // Second scan with the same hit must dedupe.
    const started2 = await ceo.post(`/api/sources/connections/${connectionId}/scan`).expect(202);
    const run2 = await waitForScan(started2.body.scanRunId);
    expect(run2.status).toBe('SUCCEEDED');
    expect(run2.itemsCreated).toBe(0);
    expect(run2.itemsDeduped).toBe(1);
    expect(await prisma.lead.count()).toBe(1);

    const history = await ceo.get('/api/sources/scans').expect(200);
    expect(history.body.total).toBeGreaterThanOrEqual(2);
    expect(history.body.summary.succeeded).toBeGreaterThanOrEqual(2);
    expect(history.body.summary.lastSuccessfulRun).toBeTruthy();
  });

  it('rejects scans when connection query is cleared (unconfigured)', async () => {
    const list = await ceo.get('/api/sources').expect(200);
    const hn = list.body.items.find((s: { key: string }) => s.key === HN_SOURCE_KEY);
    await ceo.patch(`/api/sources/connections/${hn.connection.id}`).send({ config: { query: '' } }).expect(400);
  });

  it('supports manual import fallback', async () => {
    const created = await ceo
      .post('/api/sources/manual-import')
      .send({
        name: 'Manual Clinic',
        sourceUrl: 'https://news.ycombinator.com/item?id=999001',
        requirements: 'Imported by hand while connector was offline',
      })
      .expect(201);
    expect(created.body.sources[0].source.key).toBe('manual_import');
    expect(created.body.sources[0].accessMethod).toBe('MANUAL_IMPORT');
  });

  it('forbids viewers from starting scans', async () => {
    const list = await ceo.get('/api/sources').expect(200);
    const hn = list.body.items.find((s: { key: string }) => s.key === HN_SOURCE_KEY);
    await viewer.post(`/api/sources/connections/${hn.connection.id}/scan`).expect(403);
  });
});
