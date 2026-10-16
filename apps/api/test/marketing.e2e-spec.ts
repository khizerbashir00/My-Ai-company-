import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, createTestApp, loginAgent, resetDatabase, VIEWER } from './helpers';

describe('Marketing automation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: Awaited<ReturnType<typeof loginAgent>>;
  let viewer: Awaited<ReturnType<typeof loginAgent>>;

  beforeAll(async () => {
    const built = await createTestApp();
    app = built.app;
    prisma = built.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ceo = await loginAgent(app, CEO);
    viewer = await loginAgent(app, VIEWER);
  });

  it('requires evidence URL for VERIFIED research findings and stores source attribution', async () => {
    const project = await ceo
      .post('/api/marketing/research')
      .send({
        name: 'UAE web agencies',
        country: 'AE',
        industry: 'Professional services',
        serviceOffering: 'Custom web apps',
        targetCustomerProfile: 'SMBs needing client portals',
      })
      .expect(201);

    await ceo
      .post(`/api/marketing/research/${project.body.id}/findings`)
      .send({ claim: 'Competitor X charges $5k/mo', kind: 'VERIFIED' })
      .expect(400);

    const suggestion = await ceo
      .post(`/api/marketing/research/${project.body.id}/findings`)
      .send({ claim: 'Landing pages with case studies may convert better', kind: 'SUGGESTION' })
      .expect(201);
    expect(suggestion.body.kind).toBe('SUGGESTION');
    expect(suggestion.body.evidenceUrl).toBeNull();

    const report = await ceo
      .post(`/api/marketing/research/${project.body.id}/competitors`)
      .send({
        competitorName: 'Example Agency',
        summary: 'Public positioning only',
        researchedAt: '2026-10-15T12:00:00.000Z',
        sourceUrls: ['https://example.com/services'],
        findings: [
          {
            claim: 'Lists custom web development on services page',
            kind: 'VERIFIED',
            evidenceUrl: 'https://example.com/services',
            researchedAt: '2026-10-15T12:00:00.000Z',
          },
          {
            claim: 'Estimated monthly retainer around mid-market',
            kind: 'ESTIMATE',
            sourceNote: 'Not published; do not treat as fact',
          },
        ],
      })
      .expect(201);

    expect(report.body.sources).toHaveLength(1);
    expect(report.body.sources[0].url).toBe('https://example.com/services');
    expect(report.body.findings).toHaveLength(2);
    expect(report.body.findings.map((f: { kind: string }) => f.kind).sort()).toEqual(['ESTIMATE', 'VERIFIED']);

    const detail = await ceo.get(`/api/marketing/research/${project.body.id}`).expect(200);
    expect(detail.body.competitorReports[0].sources[0].url).toContain('example.com');
    expect(new Date(detail.body.competitorReports[0].researchedAt).toISOString()).toBe('2026-10-15T12:00:00.000Z');
  });

  it('versions content drafts and enforces CEO approval before publish', async () => {
    const item = await ceo
      .post('/api/marketing/content')
      .send({ title: 'LinkedIn: portal case study teaser', channel: 'LINKEDIN', scheduledFor: new Date().toISOString() })
      .expect(201);

    await ceo.post(`/api/marketing/content/${item.body.id}/request-publish`).send({}).expect(400);

    const v1 = await ceo
      .post(`/api/marketing/content/${item.body.id}/drafts`)
      .send({ title: 'Teaser v1', body: 'First draft body with enough length.', changeNote: 'initial' })
      .expect(201);
    expect(v1.body.version).toBe(1);

    const v2 = await ceo
      .post(`/api/marketing/content/${item.body.id}/drafts`)
      .send({ title: 'Teaser v2', body: 'Second draft body with brand-safe wording.', changeNote: 'revise' })
      .expect(201);
    expect(v2.body.version).toBe(2);

    const detail = await ceo.get(`/api/marketing/content/${item.body.id}`).expect(200);
    expect(detail.body.versions).toHaveLength(2);
    expect(detail.body.currentVersion).toBe(2);

    const req = await ceo.post(`/api/marketing/content/${item.body.id}/request-publish`).send({}).expect(200);
    expect(req.body.approvalId).toBeTruthy();

    await viewer.post(`/api/approvals/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' }).expect(403);

    const decided = await ceo.post(`/api/approvals/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' }).expect(200);
    expect(decided.body.marketingResult.status).toBe('PUBLISHED');

    const published = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.body.id } });
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'content.published', entityId: item.body.id },
    });
    expect(audit).toBeTruthy();
  });

  it('enforces CEO approval before marking paid campaigns active', async () => {
    const campaign = await ceo
      .post('/api/marketing/campaigns')
      .send({
        name: 'AE SMB LinkedIn',
        objective: 'Generate attributed demo requests',
        channel: 'linkedin',
        audience: 'SMB owners in AE',
        messaging: 'Custom portals, not templates',
        isPaid: true,
        budgetRecommendation: 1500,
        budgetCurrency: 'USD',
        successMetrics: { attributed_demo_requests: { denominator: 'attributed_leads' } },
      })
      .expect(201);

    const asset = await ceo
      .post(`/api/marketing/campaigns/${campaign.body.id}/assets`)
      .send({
        type: 'LINKEDIN_POST',
        title: 'Ad concept A',
        content: 'Concept copy that does not invent performance numbers.',
      })
      .expect(201);
    expect(asset.body.currentVersion).toBe(1);

    const v2 = await ceo
      .post(`/api/marketing/assets/${asset.body.id}/versions`)
      .send({ content: 'Revised concept copy with clearer CTA.', changeNote: 'CTA tweak' })
      .expect(201);
    expect(v2.body.currentVersion).toBe(2);
    expect(v2.body.versions).toHaveLength(2);

    const launch = await ceo.post(`/api/marketing/campaigns/${campaign.body.id}/request-launch`).send({}).expect(200);
    await ceo.post(`/api/approvals/${launch.body.approvalId}/decide`).send({ decision: 'APPROVE' }).expect(200);

    const active = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.body.id } });
    expect(active.status).toBe('ACTIVE');
    expect(active.launchedAt).toBeTruthy();
  });

  it('imports campaign metrics with explicit denominators and rejects invented rate rows', async () => {
    const campaign = await ceo
      .post('/api/marketing/campaigns')
      .send({ name: 'Metrics campaign', channel: 'email', isPaid: false })
      .expect(201);

    await ceo
      .post('/api/marketing/metrics/import')
      .send({
        campaignId: campaign.body.id,
        sourceName: 'LinkedIn Ads export 2026-10-15',
        rows: [{ metricKey: 'click_through_rate', value: 12, denominatorLabel: 'impressions' }],
      })
      .expect(400);

    const imported = await ceo
      .post('/api/marketing/metrics/import')
      .send({
        campaignId: campaign.body.id,
        sourceName: 'LinkedIn Ads export 2026-10-15',
        rows: [
          { metricKey: 'clicks', value: 12 },
          {
            metricKey: 'click_through_rate',
            value: 12,
            denominator: 400,
            denominatorLabel: 'impressions',
            periodStart: '2026-10-01T00:00:00.000Z',
            periodEnd: '2026-10-15T23:59:59.000Z',
          },
        ],
      })
      .expect(201);

    expect(imported.body.conversionMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricKey: 'click_through_rate',
          numerator: 12,
          denominator: 400,
          rate: 0.03,
        }),
      ]),
    );

    const source = await prisma.source.findUniqueOrThrow({ where: { key: 'manual_import' } });
    const lead = await prisma.lead.create({
      data: {
        name: 'Attributed Co',
        contactName: 'Alex',
        contactEmail: 'alex@attributed.example',
        requirements: 'Need a portal',
        stage: 'QUALIFIED',
        sources: {
          create: {
            sourceId: source.id,
            url: 'https://example.com/campaign',
            canonicalUrl: 'https://example.com/campaign',
            accessMethod: 'MANUAL_IMPORT',
            externalId: 'attr-1',
          },
        },
      },
    });

    await ceo.post('/api/marketing/attribution').send({ leadId: lead.id, campaignId: campaign.body.id }).expect(200);

    const outcomes = await ceo.get(`/api/marketing/campaigns/${campaign.body.id}/outcomes`).expect(200);
    expect(outcomes.body.attributedLeads).toBe(1);
    expect(outcomes.body.denominators.attributedLeads).toMatch(/attributedCampaignId/);
    expect(outcomes.body.note).toMatch(/invented/i);
  });

  it('generates daily and weekly Marketing Manager reports with documented denominators', async () => {
    await ceo.post('/api/marketing/campaigns').send({ name: 'Report campaign', channel: 'linkedin' }).expect(201);

    const daily = await ceo.post('/api/marketing/reports/generate').send({ period: 'DAILY' }).expect(201);
    expect(daily.body.period).toBe('DAILY');
    expect(daily.body.metricsSnapshot.denominators.campaignsCreated).toBeTruthy();
    expect(daily.body.metricsSnapshot.caveats.join(' ')).toMatch(/invented/i);
    expect(daily.body.body).toContain('Campaigns created:');

    const weekly = await ceo.post('/api/marketing/reports/generate').send({ period: 'WEEKLY' }).expect(201);
    expect(weekly.body.period).toBe('WEEKLY');

    const list = await ceo.get('/api/marketing/reports').expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);

    const one = await ceo.get(`/api/marketing/reports/${daily.body.id}`).expect(200);
    expect(one.body.title).toMatch(/Daily Marketing Manager/);
  });

  it('exposes brand profile and analytics integrations without inventing metrics', async () => {
    const brand = await ceo.get('/api/marketing/brand').expect(200);
    expect(brand.body.key).toBe('default');

    await ceo
      .patch('/api/marketing/brand')
      .send({
        voiceGuidelines: 'Direct and concrete.',
        servicesOffered: ['Custom web apps', 'Client portals'],
        approvedClaims: ['We build custom software after deals are confirmed.'],
      })
      .expect(200);

    const analytics = await ceo.get('/api/marketing/analytics').expect(200);
    expect(analytics.body.integrations.some((i: { key: string }) => i.key === 'manual_import')).toBe(true);
    expect(analytics.body.integrations.find((i: { key: string }) => i.key === 'google_analytics').isConfigured).toBe(false);
  });
});
