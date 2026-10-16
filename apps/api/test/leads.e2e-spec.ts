import { INestApplication } from '@nestjs/common';
import { FakeAiProvider } from '../src/ai/fake-ai.provider';
import { SCORING_CRITERIA } from '../src/leads/scoring-rubric';
import { PrismaService } from '../src/prisma/prisma.service';
import { agentIdByKey, CEO, createTestApp, loginAgent, nextClientIp, resetDatabase, VIEWER } from './helpers';

describe('Leads CRM (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeAi: FakeAiProvider;
  let ceo: Awaited<ReturnType<typeof loginAgent>>;
  let viewer: Awaited<ReturnType<typeof loginAgent>>;
  let salesManagerId: string;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'test-key-not-sent';
    process.env.OPENAI_MODEL = 'gpt-test';
    fakeAi = new FakeAiProvider();
    ({ app, prisma } = await createTestApp({ fakeAi }));
  });

  afterAll(async () => {
    await app.close();
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_MODEL = '';
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    fakeAi.clear();
    ceo = await loginAgent(app, CEO);
    viewer = await loginAgent(app, VIEWER);
    salesManagerId = await agentIdByKey(prisma, 'sales_manager');
  });

  const sampleLead = (overrides: Record<string, unknown> = {}) => ({
    name: 'Acme Dental',
    contactName: 'Jane Founder',
    contactEmail: 'jane@acme-dental.example',
    websiteUrl: 'https://acme-dental.example',
    requirements: 'Need a React marketing site and booking form',
    requestedSkills: ['React', 'Next.js'],
    budgetText: '$8k stated in post',
    sourceUrl: 'https://reddit.com/r/webdev/comments/abc123',
    externalId: 'abc123',
    notes: 'Found via manual review',
    assignedAgentId: salesManagerId,
    ...overrides,
  });

  it('creates, lists, updates and fetches a lead', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    expect(created.body.name).toBe('Acme Dental');
    expect(created.body.sources[0].source.key).toBe('manual_import');
    expect(created.body.sources[0].accessMethod).toBe('MANUAL_IMPORT');
    expect(created.body.assignedAgent.key).toBe('sales_manager');

    const list = await ceo.get('/api/leads?search=Acme').expect(200);
    expect(list.body.total).toBe(1);

    const updated = await ceo
      .patch(`/api/leads/${created.body.id}`)
      .send({ notes: 'Called receptionist' })
      .expect(200);
    expect(updated.body.notes).toBe('Called receptionist');

    const detail = await ceo.get(`/api/leads/${created.body.id}`).expect(200);
    expect(detail.body.id).toBe(created.body.id);
  });

  it('rejects invalid create payloads', async () => {
    await ceo.post('/api/leads').send({ name: 'X', sourceUrl: 'not-a-url' }).expect(400);
    await ceo.post('/api/leads').send({ name: 'X', sourceUrl: 'https://ok.example' }).expect(400); // name too short? min 2 - "X" is 1 char... actually MinLength(2) so "X" fails. Good.
  });

  it('detects duplicates by canonical URL and external id (not by name)', async () => {
    await ceo.post('/api/leads').send(sampleLead()).expect(201);
    const dupUrl = await ceo
      .post('/api/leads')
      .send(sampleLead({ name: 'Totally Different Name', externalId: 'other-id' }))
      .expect(409);
    expect(dupUrl.body.message).toMatch(/already exists/i);

    const dupExt = await ceo
      .post('/api/leads')
      .send(
        sampleLead({
          name: 'Another Co',
          sourceUrl: 'https://reddit.com/r/webdev/comments/zzz999',
          externalId: 'abc123',
        }),
      )
      .expect(409);
    expect(dupExt.body.message).toMatch(/already exists/i);

    // Same name, different source evidence → allowed
    await ceo
      .post('/api/leads')
      .send(
        sampleLead({
          name: 'Acme Dental',
          sourceUrl: 'https://news.ycombinator.com/item?id=999',
          externalId: 'hn-999',
        }),
      )
      .expect(201);
  });

  it('scores a lead with the rubric and moves NEW → QUALIFIED', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    const criteria = SCORING_CRITERIA.map((c) => ({
      key: c.key,
      score: Math.min(10, c.max),
      reason: `Evidence for ${c.key}`,
    }));
    const scored = await ceo.post(`/api/leads/${created.body.id}/score`).send({ criteria }).expect(200);
    expect(scored.body.latestScore).toBeGreaterThan(0);
    expect(scored.body.intentLabel).toBeTruthy();
    expect(scored.body.stage).toBe('QUALIFIED');
    expect(scored.body.scores[0].rubricVersion).toBe('1.0');
  });

  it('enforces pipeline transitions', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    await ceo.post(`/api/leads/${created.body.id}/transition`).send({ to: 'WON' }).expect(400);
    await ceo.post(`/api/leads/${created.body.id}/transition`).send({ to: 'QUALIFIED' }).expect(200);
    await ceo.post(`/api/leads/${created.body.id}/transition`).send({ to: 'CONTACTED' }).expect(200);
    const lost = await ceo
      .post(`/api/leads/${created.body.id}/transition`)
      .send({ to: 'LOST', lostReason: 'No budget' })
      .expect(200);
    expect(lost.body.stage).toBe('LOST');
    expect(lost.body.lostReason).toBe('No budget');
  });

  it('CSV import preview reports row errors and confirm imports valid rows', async () => {
    const csv = [
      'name,source_url,contact_email,external_id',
      'Good Co,https://example.com/a,ok@example.com,e1',
      ',https://example.com/b,bad-email,e2',
      'Dup Co,https://example.com/a,other@example.com,e3',
    ].join('\n');

    const preview = await ceo.post('/api/leads/import/preview').send({ csv }).expect(200);
    expect(preview.body.isManualImport).toBe(true);
    expect(preview.body.validCount).toBe(1);
    expect(preview.body.errorCount).toBe(2);
    expect(preview.body.rows[1].errors.length).toBeGreaterThan(0);

    // First import the good row
    const confirm = await ceo
      .post('/api/leads/import/confirm')
      .send({ rows: [preview.body.rows[0].data] })
      .expect(200);
    expect(confirm.body.createdCount).toBe(1);

    // Preview again — previous good URL is now a duplicate
    const preview2 = await ceo.post('/api/leads/import/preview').send({ csv }).expect(200);
    expect(preview2.body.rows[0].errors.join(' ')).toMatch(/Duplicate/i);
  });

  it('exports CSV of leads', async () => {
    await ceo.post('/api/leads').send(sampleLead()).expect(201);
    const res = await ceo.get('/api/leads/export').expect(200);
    expect(res.text).toMatch(/Acme Dental/);
    expect(res.text).toMatch(/source_url|name/);
  });

  it('creates a manual outreach draft and blocks sending', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    const draft = await ceo
      .post(`/api/leads/${created.body.id}/outreach`)
      .send({
        subject: 'Quick note about your React site',
        body: 'Hi Jane — saw your request for a React marketing site and booking form. Happy to share relevant work.',
        rationale: 'References their stated requirements only.',
      })
      .expect(201);
    expect(draft.body.status).toBe('DRAFT');

    const lead = await ceo.get(`/api/leads/${created.body.id}`).expect(200);
    expect(lead.body.stage).toBe('DRAFT_READY');

    await ceo
      .patch(`/api/leads/${created.body.id}/outreach/${draft.body.id}`)
      .send({ status: 'SENT' })
      .expect(400);
  });

  it('generates an AI outreach draft without fabricating source integrations', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    fakeAi.enqueue({
      subject: 'Your React marketing site request',
      body: 'Hi Jane — you asked for a React marketing site and booking form. I build those for clinics.',
      rationale: 'Uses only the requirements and contact name from the lead.',
    });
    const draft = await ceo.post(`/api/leads/${created.body.id}/outreach/generate`).send({ channel: 'EMAIL' }).expect(201);
    expect(draft.body.body).toMatch(/React/i);
    expect(draft.body.status).toBe('DRAFT');
  });

  it('returns a client briefing with source links and demo prep', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    const briefing = await ceo.get(`/api/leads/${created.body.id}/briefing`).expect(200);
    expect(briefing.body.sources[0].url).toMatch(/reddit.com/);
    expect(briefing.body.sources[0].isManualImport).toBe(true);
    expect(briefing.body.demoPrep.points.length).toBeGreaterThan(0);
  });

  it('pipeline endpoint groups by stage', async () => {
    await ceo.post('/api/leads').send(sampleLead()).expect(201);
    const pipe = await ceo.get('/api/leads/pipeline').expect(200);
    expect(pipe.body.columns.find((c: { stage: string }) => c.stage === 'NEW').count).toBe(1);
  });

  it('enforces authorization: viewers are read-only; unauthenticated is 401', async () => {
    const created = await ceo.post('/api/leads').send(sampleLead()).expect(201);
    await viewer.get('/api/leads').expect(200);
    await viewer.post('/api/leads').send(sampleLead({ sourceUrl: 'https://example.com/v', externalId: 'v1' })).expect(403);
    await viewer.patch(`/api/leads/${created.body.id}`).send({ notes: 'nope' }).expect(403);

    const { default: request } = await import('supertest');
    await request(app.getHttpServer()).get('/api/leads').set('X-Forwarded-For', nextClientIp()).expect(401);
  });

  it('exposes the scoring rubric', async () => {
    const res = await ceo.get('/api/leads/meta/rubric').expect(200);
    expect(res.body.version).toBe('1.0');
    expect(res.body.maxScore).toBe(100);
    expect(res.body.criteria.length).toBe(SCORING_CRITERIA.length);
  });
});
