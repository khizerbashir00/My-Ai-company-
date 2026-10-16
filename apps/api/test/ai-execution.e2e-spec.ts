import { INestApplication } from '@nestjs/common';
import { AiCredentialsError, AiOutputValidationError, AiProviderError } from '../src/ai/ai.errors';
import { FakeAiProvider } from '../src/ai/fake-ai.provider';
import type { AgentTurn } from '../src/ai/schemas';
import { PrismaService } from '../src/prisma/prisma.service';
import { agentIdByKey, CEO, createTestApp, loginAgent, resetDatabase } from './helpers';

describe('AI execution (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeAi: FakeAiProvider;
  let ceo: Awaited<ReturnType<typeof loginAgent>>;
  let gmId: string;
  let salesManagerId: string;
  let researchWorkerId: string;

  beforeAll(async () => {
    // Credentials must be present for aiReady; the FakeAiProvider never calls OpenAI.
    process.env.OPENAI_API_KEY = 'test-key-not-sent-anywhere';
    process.env.OPENAI_MODEL = 'gpt-test-routine';
    process.env.OPENAI_MODEL_ADVANCED = 'gpt-test-advanced';
    fakeAi = new FakeAiProvider();
    ({ app, prisma } = await createTestApp({ fakeAi }));
  });

  afterAll(async () => {
    await app.close();
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_MODEL = '';
    process.env.OPENAI_MODEL_ADVANCED = '';
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    fakeAi.clear();
    ceo = await loginAgent(app, CEO);
    gmId = await agentIdByKey(prisma, 'general_manager');
    salesManagerId = await agentIdByKey(prisma, 'sales_manager');
    researchWorkerId = await agentIdByKey(prisma, 'lead_research_worker');
  });

  async function createGoal(title = 'Find USA website development leads') {
    const res = await ceo
      .post('/api/tasks')
      .send({
        title,
        description: 'Qualify and prepare outreach drafts when possible.',
        assignedAgentId: gmId,
        kind: 'GOAL',
      })
      .expect(201);
    return res.body.task as { id: string; status: string };
  }

  function gmTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
    return {
      notes: 'Delegating to Sales Manager',
      plan: {
        objective: 'Discover website-development leads',
        rationale: 'Sales owns discovery',
        steps: [
          {
            key: 'sales-1',
            title: 'Plan sales discovery',
            description: 'Coordinate workers once connectors exist',
            departmentKey: 'sales',
            assigneeAgentKey: 'sales_manager',
            priority: 'HIGH',
          },
        ],
        blockedCapabilities: ['Lead source connectors are not configured yet (phase 4).'],
        risks: [],
      },
      result: {
        summary: 'Delegated discovery planning to Sales Manager. No leads invented.',
        outcome: 'completed',
        findings: [],
        blockedReasons: ['Lead source connectors are not configured yet (phase 4).'],
        nextActions: ['Wait for Sales Manager plan'],
      },
      toolRequests: [
        {
          tool: 'delegate_task',
          title: 'Plan sales discovery',
          description: 'Coordinate workers once connectors exist',
          assigneeAgentKey: 'sales_manager',
          stepKey: 'sales-1',
          priority: 'HIGH',
        },
      ],
      ...overrides,
    };
  }

  function workerBlockedTurn(): AgentTurn {
    return {
      notes: 'Cannot search sources in this phase',
      plan: null,
      result: {
        summary: 'Blocked: no authorized lead-source connector is configured.',
        outcome: 'blocked',
        findings: [],
        blockedReasons: ['search_lead_sources is not available until phase 4'],
        nextActions: ['Configure an authorized source connector'],
      },
      toolRequests: [],
    };
  }

  it('runs a successful GM plan, creates a sales subtask, records a run and usage', async () => {
    const goal = await createGoal();
    fakeAi.enqueue(gmTurn());
    // Cascade will try the child — queue a manager turn that only plans (no further cascade needed if maxDepth low)
    fakeAi.enqueue({
      notes: 'Acknowledging',
      plan: {
        objective: 'Prepare workers',
        rationale: 'Connectors unavailable',
        steps: [],
        blockedCapabilities: ['Lead source connectors unavailable'],
        risks: [],
      },
      result: {
        summary: 'No worker tasks created because source connectors are unavailable.',
        outcome: 'completed',
        findings: [],
        blockedReasons: ['Lead source connectors unavailable'],
        nextActions: [],
      },
      toolRequests: [],
    } satisfies AgentTurn);

    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: true, maxDepth: 1 }).expect(200);
    expect(res.body.deduplicated).toBe(false);
    expect(res.body.task.status).toBe('COMPLETED');
    expect(res.body.childrenCreated.length).toBeGreaterThanOrEqual(1);

    const runs = await prisma.agentRun.findMany({ where: { taskId: goal.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('SUCCEEDED');
    expect(runs[0].model).toBe('gpt-test-advanced'); // GM uses ADVANCED tier

    const usage = await prisma.usageRecord.count({ where: { agentRunId: runs[0].id } });
    expect(usage).toBe(1);

    const child = await prisma.task.findFirst({ where: { parentTaskId: goal.id } });
    expect(child?.assignedAgentId).toBe(salesManagerId);
    expect(child?.idempotencyKey).toBe(`delegate:${goal.id}:sales-1`);
  });

  it('rejects invalid model output', async () => {
    const goal = await createGoal();
    fakeAi.enqueue({ notes: 'broken', plan: null, result: null, toolRequests: 'nope' });
    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(400);
    expect(String(res.body.message)).toMatch(/schema|invalid|validation|output/i);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: goal.id } });
    expect(task.status).toBe('FAILED');
  });

  it('fails clearly when API credentials are unavailable', async () => {
    const key = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_MODEL = '';
    // Reboot is heavy; instead call assert path via a fresh Fake that throws credentials
    // by emptying the in-memory config — Nest already cached env. Use handler:
    fakeAi.setHandler(async () => {
      throw new AiCredentialsError();
    });
    // Restore for other tests after — but aiReady still true from boot. Force credentials error via handler.
    process.env.OPENAI_API_KEY = key;
    process.env.OPENAI_MODEL = model;

    const goal = await createGoal();
    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(503);
    expect(String(res.body.message)).toMatch(/not configured|credentials/i);
  });

  it('surfaces provider errors without leaking secrets', async () => {
    const goal = await createGoal();
    fakeAi.setHandler(async () => {
      throw new AiProviderError('AI provider rate limit reached. Try again shortly.', true);
    });
    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/test-key|sk-/i);
    expect(String(res.body.message)).toMatch(/rate limit|provider/i);
  });

  it('denies unauthorized tools and records a DENIED tool call', async () => {
    const goal = await createGoal();
    fakeAi.enqueue(
      gmTurn({
        toolRequests: [
          {
            tool: 'search_lead_sources',
            title: null,
            description: null,
            assigneeAgentKey: null,
            stepKey: null,
            priority: null,
          },
        ],
        plan: null,
        result: {
          summary: 'Attempted unavailable tool',
          outcome: 'blocked',
          findings: [],
          blockedReasons: ['search_lead_sources unavailable'],
          nextActions: [],
        },
      }),
    );

    await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(200);
    const denied = await prisma.toolCall.findFirst({ where: { toolName: 'search_lead_sources' } });
    expect(denied?.status).toBe('DENIED');
    expect(denied?.errorMessage).toMatch(/not available|not configured|Unknown|permission/i);
  });

  it('prevents duplicate concurrent execution', async () => {
    const goal = await createGoal();
    // Simulate an in-flight run without holding an HTTP request open (supertest agents serialize).
    await prisma.task.update({ where: { id: goal.id }, data: { status: 'RUNNING', attempts: 1, startedAt: new Date() } });
    await prisma.agentRun.create({
      data: {
        taskId: goal.id,
        agentId: gmId,
        status: 'RUNNING',
        provider: 'openai',
        model: 'gpt-test-advanced',
      },
    });

    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(200);
    expect(res.body.deduplicated).toBe(true);
    expect(res.body.message).toMatch(/already running|claimed/i);
  });

  it('stops when the task is cancelled before the model returns', async () => {
    const goal = await createGoal();
    fakeAi.setHandler(async () => {
      await prisma.task.update({ where: { id: goal.id }, data: { status: 'CANCELLED', completedAt: new Date() } });
      const { AiCancelledError } = await import('../src/ai/ai.errors');
      throw new AiCancelledError('Task was cancelled before the model call.');
    });

    await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: goal.id } });
    expect(task.status).toBe('CANCELLED');
  });

  it('refuses to run after retry exhaustion', async () => {
    const goal = await createGoal();
    await prisma.task.update({
      where: { id: goal.id },
      data: { status: 'FAILED', attempts: 3, maxAttempts: 3, errorMessage: 'prior failure' },
    });
    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(400);
    expect(String(res.body.message)).toMatch(/Retry limit reached/i);
  });

  it('blocks worker execution without fabricating leads', async () => {
    const taskRes = await ceo
      .post('/api/tasks')
      .send({
        title: 'Research leads',
        description: 'Search configured sources only',
        assignedAgentId: researchWorkerId,
      })
      .expect(201);
    const taskId = taskRes.body.task.id as string;
    fakeAi.enqueue(workerBlockedTurn());

    const res = await ceo.post(`/api/orchestration/tasks/${taskId}/run`).send({ cascade: false }).expect(200);
    expect(res.body.task.status).toBe('FAILED');
    expect(res.body.task.errorMessage).toMatch(/connector|phase|unavailable|blocked/i);

    const leads = await prisma.lead.count();
    expect(leads).toBe(0);
  });

  it('does not expose the API key via system status', async () => {
    const res = await ceo.get('/api/system/status').expect(200);
    expect(res.body.ai).toEqual({
      provider: 'openai',
      apiKeyConfigured: true,
      routineModel: 'gpt-test-routine',
      advancedModel: 'gpt-test-advanced',
    });
    expect(res.body.email).toMatchObject({ configured: expect.any(Boolean) });
    expect(JSON.stringify(res.body)).not.toMatch(/test-key-not-sent|re_/i);
  });

  it('creates an approval instead of executing approval-locked side effects', async () => {
    // request_publish_content creates a PUBLISH_CONTENT approval; content is not marked published until CEO decides.
    await prisma.agentDefinition.update({
      where: { id: gmId },
      data: { tools: ['delegate_task', 'submit_result', 'request_publish_content'] },
    });
    await prisma.agentPermission.create({
      data: { agentId: gmId, permission: 'content.publish', requiresApproval: true },
    });

    const content = await prisma.contentItem.create({
      data: {
        title: 'Approval gate draft',
        channel: 'LINKEDIN',
        status: 'DRAFTING',
        currentVersion: 1,
        versions: {
          create: {
            version: 1,
            title: 'Approval gate draft',
            body: 'Draft body long enough for publish request.',
            status: 'DRAFT',
          },
        },
      },
    });

    const goal = await createGoal('Approval gate test');
    fakeAi.enqueue(
      gmTurn({
        plan: null,
        toolRequests: [
          {
            tool: 'request_publish_content',
            title: null,
            description: null,
            assigneeAgentKey: null,
            stepKey: null,
            priority: null,
            contentItemId: content.id,
            leadId: null,
            messageId: null,
            campaignId: null,
          },
        ],
        result: {
          summary: 'Requested publish',
          outcome: 'needs_review',
          findings: [],
          blockedReasons: [],
          nextActions: [],
        },
      }),
    );

    const res = await ceo.post(`/api/orchestration/tasks/${goal.id}/run`).send({ cascade: false }).expect(200);
    expect(res.body.awaitingApproval).toBe(true);
    expect(res.body.task.status).toBe('AWAITING_APPROVAL');
    const approval = await prisma.approval.findFirst({ where: { taskId: goal.id } });
    expect(approval?.status).toBe('PENDING');
    expect(approval?.actionType).toBe('PUBLISH_CONTENT');

    const stillDraft = await prisma.contentItem.findUniqueOrThrow({ where: { id: content.id } });
    expect(stillDraft.status).toBe('AWAITING_APPROVAL');
    expect(stillDraft.publishedAt).toBeNull();
  });
});

describe('AI execution without credentials (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_MODEL = '';
    process.env.OPENAI_MODEL_ADVANCED = '';
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 when credentials are not configured', async () => {
    await resetDatabase(prisma);
    const ceo = await loginAgent(app, CEO);
    const gmId = await agentIdByKey(prisma, 'general_manager');
    const created = await ceo
      .post('/api/tasks')
      .send({ title: 'Goal without AI', assignedAgentId: gmId })
      .expect(201);

    // Status stays honest
    const status = await ceo.get('/api/system/status').expect(200);
    expect(status.body.ai.apiKeyConfigured).toBe(false);

    const res = await ceo.post(`/api/orchestration/tasks/${created.body.task.id}/run`).send({}).expect(503);
    expect(String(res.body.message)).toMatch(/not configured/i);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-/i);
  });
});

// Silence unused import in case tree-shaking complains in some tooling
void AiOutputValidationError;
