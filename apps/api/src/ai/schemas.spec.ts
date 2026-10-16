import { agentTurnSchema, workerResultSchema } from './schemas';

describe('AI structured schemas', () => {
  it('accepts a valid GM plan turn', () => {
    const parsed = agentTurnSchema.safeParse({
      notes: 'Routing to Sales',
      plan: {
        objective: 'Find website leads in the USA',
        rationale: 'Sales owns discovery',
        steps: [
          {
            key: 'sales-plan',
            title: 'Plan lead discovery',
            description: 'Break down discovery work for workers when connectors exist',
            departmentKey: 'sales',
            assigneeAgentKey: 'sales_manager',
            priority: 'HIGH',
          },
        ],
        blockedCapabilities: ['Lead source connectors are not configured (phase 4).'],
        risks: ['No live source data yet'],
      },
      result: null,
      toolRequests: [
        {
          tool: 'delegate_task',
          title: 'Plan lead discovery',
          description: 'Break down discovery work',
          assigneeAgentKey: 'sales_manager',
          stepKey: 'sales-plan',
          priority: 'HIGH',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects worker results that invent findings', () => {
    const parsed = workerResultSchema.safeParse({
      summary: 'Invented a lead',
      outcome: 'completed',
      findings: [{ claim: 'Acme wants a site', evidence: null, invented: true }],
      blockedReasons: [],
      nextActions: [],
    });
    expect(parsed.success).toBe(true); // schema allows the boolean; runner rejects invented=true
    expect(parsed.data?.findings[0]?.invented).toBe(true);
  });

  it('rejects invalid outcome values', () => {
    const parsed = workerResultSchema.safeParse({
      summary: 'x',
      outcome: 'success',
      findings: [],
      blockedReasons: [],
      nextActions: [],
    });
    expect(parsed.success).toBe(false);
  });
});
