import { INestApplication } from '@nestjs/common';
import { EMAIL_PROVIDER } from '../src/email/email.types';
import type { EmailProvider, SendEmailInput, SendEmailResult } from '../src/email/email.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, createTestApp, loginAgent, resetDatabase, VIEWER } from './helpers';

class FakeEmailProvider implements EmailProvider {
  readonly key = 'resend';
  configured = true;
  failNext = false;
  sent: SendEmailInput[] = [];

  isConfigured(): boolean {
    return this.configured;
  }
  fromAddress(): string | null {
    return this.configured ? 'ceo@example.test' : null;
  }
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.configured) throw new Error('not configured');
    if (this.failNext) {
      this.failNext = false;
      const { EmailProviderError } = await import('../src/email/email.types');
      throw new EmailProviderError('Provider rejected message', false, '422');
    }
    this.sent.push(input);
    return { provider: this.key, messageId: `msg_${this.sent.length}`, deliveryStatus: 'sent' };
  }
}

describe('Approval-based outreach (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ceo: Awaited<ReturnType<typeof loginAgent>>;
  let viewer: Awaited<ReturnType<typeof loginAgent>>;
  let fakeMail: FakeEmailProvider;

  beforeAll(async () => {
    fakeMail = new FakeEmailProvider();
    const built = await createTestApp();
    app = built.app;
    prisma = built.prisma;
    // Override EmailService's active provider via module — patch EmailService methods.
    const { EmailService } = await import('../src/email/email.service');
    const email = app.get(EmailService);
    jest.spyOn(email, 'activeProvider').mockImplementation(() => (fakeMail.configured ? fakeMail : null));
    jest.spyOn(email, 'send').mockImplementation((input) => fakeMail.send(input));
    jest.spyOn(email, 'status').mockImplementation(() => ({
      provider: 'resend',
      configured: fakeMail.configured,
      fromAddress: fakeMail.fromAddress(),
      replyTo: null,
      inboundWebhookConfigured: false,
    }));
    void EMAIL_PROVIDER;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    fakeMail.sent = [];
    fakeMail.configured = true;
    fakeMail.failNext = false;
    ceo = await loginAgent(app, CEO);
    viewer = await loginAgent(app, VIEWER);
  });

  async function seedLead() {
    const source = await prisma.source.findUniqueOrThrow({ where: { key: 'manual_import' } });
    return prisma.lead.create({
      data: {
        name: 'Outreach Co',
        contactName: 'Pat',
        contactEmail: 'pat@outreach-co.example',
        requirements: 'Need a marketing site',
        stage: 'QUALIFIED',
        sources: {
          create: {
            sourceId: source.id,
            url: 'https://example.com/post/1',
            canonicalUrl: 'https://example.com/post/1',
            accessMethod: 'MANUAL_IMPORT',
            externalId: 'out-1',
          },
        },
      },
    });
  }

  it('enforces CEO approval before send and records provider message id', async () => {
    const lead = await seedLead();
    const draft = await ceo
      .post(`/api/leads/${lead.id}/outreach`)
      .send({ subject: 'Quick question', body: 'Hi Pat — saw your post about a marketing site. Open to a short chat?' })
      .expect(201);

    // Direct SENT patch forbidden
    await ceo.patch(`/api/leads/${lead.id}/outreach/${draft.body.id}`).send({ status: 'SENT' }).expect(400);

    const req = await ceo.post(`/api/leads/${lead.id}/outreach/${draft.body.id}/request-send`).send({}).expect(200);
    expect(req.body.approvalId).toBeTruthy();

    await viewer.post(`/api/approvals/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' }).expect(403);

    const decided = await ceo.post(`/api/approvals/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' }).expect(200);
    expect(decided.body.sendResult.status).toBe('SENT');
    expect(decided.body.sendResult.providerMessageId).toMatch(/^msg_/);
    expect(fakeMail.sent).toHaveLength(1);
    expect(fakeMail.sent[0]!.to).toBe('pat@outreach-co.example');

    const msg = await prisma.outreachMessage.findUniqueOrThrow({ where: { id: draft.body.id } });
    expect(msg.status).toBe('SENT');
    expect(msg.providerMessageId).toBeTruthy();
  });

  it('surfaces email provider failures without sending', async () => {
    const lead = await seedLead();
    const draft = await ceo
      .post(`/api/leads/${lead.id}/outreach`)
      .send({ subject: 'Hello', body: 'This is a long enough outreach body for validation.' })
      .expect(201);
    const req = await ceo.post(`/api/leads/${lead.id}/outreach/${draft.body.id}/request-send`).send({}).expect(200);
    fakeMail.failNext = true;
    const res = await ceo.post(`/api/approvals/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' }).expect(503);
    expect(String(res.body.message)).toMatch(/Provider|fail|reject/i);
    const msg = await prisma.outreachMessage.findUniqueOrThrow({ where: { id: draft.body.id } });
    expect(msg.status).toBe('FAILED');
    expect(msg.lastProviderError).toBeTruthy();
  });

  it('classifies replies, cancels follow-ups on opt-out, and dedupes notifications', async () => {
    const lead = await seedLead();
    const sent = await prisma.outreachMessage.create({
      data: {
        leadId: lead.id,
        channel: 'EMAIL',
        subject: 'Hello',
        body: 'Body text here for the outreach message.',
        status: 'SENT',
        sentAt: new Date(),
        provider: 'resend',
        providerMessageId: 'out_abc',
        recipientEmail: 'pat@outreach-co.example',
      },
    });
    await prisma.outreachMessage.create({
      data: {
        leadId: lead.id,
        channel: 'EMAIL',
        subject: 'Follow-up',
        body: 'Just bumping this in case you missed it earlier today.',
        status: 'SCHEDULED',
        isFollowUp: true,
        parentMessageId: sent.id,
        scheduledFor: new Date(Date.now() + 86_400_000),
      },
    });

    const inbound = await ceo
      .post('/api/webhooks/email/inbound')
      .send({
        fromEmail: 'pat@outreach-co.example',
        bodyText: 'Please unsubscribe me',
        providerMessageId: 'in_1',
        inReplyTo: 'out_abc',
      })
      .expect(200);
    expect(inbound.body.ok).toBe(true);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.doNotContact).toBe(true);
    expect(updated.stage).toBe('DO_NOT_CONTACT');

    const followUps = await prisma.outreachMessage.findMany({ where: { leadId: lead.id, isFollowUp: true } });
    expect(followUps.every((f) => f.status === 'CANCELLED')).toBe(true);

    // Positive reply notification dedupe
    const lead2 = await prisma.lead.create({
      data: {
        name: 'Other Co',
        contactEmail: 'other@example.test',
        requirements: 'Site',
        sources: {
          create: {
            sourceId: (await prisma.source.findUniqueOrThrow({ where: { key: 'manual_import' } })).id,
            url: 'https://example.com/post/2',
            canonicalUrl: 'https://example.com/post/2',
            accessMethod: 'MANUAL_IMPORT',
            externalId: 'out-2',
          },
        },
      },
    });
    await ceo
      .post('/api/webhooks/email/inbound')
      .send({ fromEmail: 'other@example.test', bodyText: 'Sounds good — tell me more', providerMessageId: 'in_pos_1' })
      .expect(200);
    await ceo
      .post('/api/webhooks/email/inbound')
      .send({ fromEmail: 'other@example.test', bodyText: 'Sounds good — tell me more', providerMessageId: 'in_pos_1' })
      .expect(200);

    const notes = await prisma.notification.findMany({ where: { type: 'POSITIVE_REPLY' } });
    expect(notes.length).toBe(1);
    void lead2;
  });

  it('requires scope confirmation to create a Won project', async () => {
    const lead = await seedLead();
    await prisma.lead.update({ where: { id: lead.id }, data: { stage: 'NEGOTIATION' } });

    await ceo.post(`/api/leads/${lead.id}/transition`).send({ to: 'WON' }).expect(400);

    const confirmed = await ceo
      .post(`/api/leads/${lead.id}/confirm-deal`)
      .send({ scope: 'Build marketing site with booking form and CMS.', dealValue: 8500, currency: 'USD' })
      .expect(200);
    expect(confirmed.body.project.id).toBeTruthy();
    expect(confirmed.body.project.description).toMatch(/booking form/);

    const won = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(won.stage).toBe('WON');
    const project = await prisma.project.findUniqueOrThrow({ where: { leadId: lead.id } });
    expect(Number(project.dealValue)).toBe(8500);
  });

  it('pauses outreach and stops scheduled follow-ups', async () => {
    const lead = await seedLead();
    await ceo
      .post(`/api/leads/${lead.id}/follow-ups`)
      .send({
        scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
        body: 'Following up on my previous note about your site project.',
      })
      .expect(201);

    await ceo.post(`/api/leads/${lead.id}/outreach/pause`).expect(200);
    const paused = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(paused.outreachPausedAt).toBeTruthy();

    const scheduled = await prisma.outreachMessage.findMany({ where: { leadId: lead.id, isFollowUp: true } });
    expect(scheduled.every((m) => m.status === 'CANCELLED')).toBe(true);
  });
});
