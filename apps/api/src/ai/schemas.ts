import { z } from 'zod';

/**
 * Structured outputs from the General Manager / managers / workers.
 * OpenAI strict JSON schema requires every property in `required` and dislikes
 * open maps / unknown — keep fields explicit and nullable instead of optional.
 */
export const planStepSchema = z.object({
  key: z.string().min(1).max(80),
  title: z.string().min(3).max(200),
  description: z.string().max(2000),
  departmentKey: z.enum(['sales', 'marketing']),
  assigneeAgentKey: z.string().min(1).max(80),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
});

export const executionPlanSchema = z.object({
  objective: z.string().min(1).max(1000),
  rationale: z.string().max(2000),
  steps: z.array(planStepSchema).max(20),
  blockedCapabilities: z.array(z.string().max(300)).max(20),
  risks: z.array(z.string().max(300)).max(20),
});

export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;

export const findingSchema = z.object({
  claim: z.string().max(1000),
  /** Source URL or note; null when unavailable — never invent. */
  evidence: z.string().max(2000).nullable(),
  /** Must stay false. Invented claims are rejected by the runner. */
  invented: z.boolean(),
});

export const workerResultSchema = z.object({
  summary: z.string().min(1).max(2000),
  outcome: z.enum(['completed', 'blocked', 'needs_review']),
  findings: z.array(findingSchema).max(50),
  blockedReasons: z.array(z.string().max(300)).max(20),
  nextActions: z.array(z.string().max(300)).max(20),
});

export type WorkerResult = z.infer<typeof workerResultSchema>;

/**
 * Model-requested tool calls. Arguments are flattened (no open records) so the
 * schema stays compatible with OpenAI structured outputs. The runner maps these
 * into tool-executor argument objects.
 */
export const toolRequestSchema = z.object({
  tool: z.string().min(1).max(80),
  title: z.string().max(200).nullable(),
  description: z.string().max(2000).nullable(),
  assigneeAgentKey: z.string().max(80).nullable(),
  stepKey: z.string().max(80).nullable(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).nullable(),
  /** Target entities for tools that need them (flattened for structured-output compatibility). */
  leadId: z.string().max(80).nullish(),
  messageId: z.string().max(80).nullish(),
  contentItemId: z.string().max(80).nullish(),
  campaignId: z.string().max(80).nullish(),
});

export type ToolRequest = z.infer<typeof toolRequestSchema>;

export const agentTurnSchema = z.object({
  notes: z.string().max(2000),
  plan: executionPlanSchema.nullable(),
  result: workerResultSchema.nullable(),
  toolRequests: z.array(toolRequestSchema).max(20),
});

export type AgentTurn = z.infer<typeof agentTurnSchema>;

export function toolRequestToArgs(req: ToolRequest): Record<string, unknown> {
  return {
    title: req.title,
    description: req.description,
    assigneeAgentKey: req.assigneeAgentKey,
    stepKey: req.stepKey,
    priority: req.priority,
    ...(req.leadId && { leadId: req.leadId }),
    ...(req.messageId && { messageId: req.messageId }),
    ...(req.contentItemId && { contentItemId: req.contentItemId }),
    ...(req.campaignId && { campaignId: req.campaignId }),
  };
}
