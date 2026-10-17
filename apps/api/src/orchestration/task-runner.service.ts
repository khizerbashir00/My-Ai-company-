import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { AiService } from '../ai/ai.service';
import {
  AiCancelledError,
  AiCredentialsError,
  AiOutputValidationError,
  AiProviderError,
} from '../ai/ai.errors';
import { AI_CALL_TIMEOUT_MS, CURRENT_EXECUTION_PHASE } from '../ai/ai.types';
import { agentTurnSchema, toolRequestToArgs, type AgentTurn, type ToolRequest, type WorkerResult } from '../ai/schemas';
import { TasksService, type TaskActor } from '../tasks/tasks.service';
import { RunsService } from './runs.service';
import { GmPlannerService } from './gm-planner.service';
import { MessagesService } from '../messages/messages.service';
import { ToolExecutorService, type ToolExecutionContext } from './tool-executor.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import type { TaskDetail } from '../tasks/tasks.service';

export interface RunTaskOptions {
  /** When true, also run newly created QUEUED children (depth-limited). */
  cascade?: boolean;
  /** Max cascade depth (goal→manager→worker = 2). */
  maxDepth?: number;
}

export interface RunTaskResult {
  task: TaskDetail;
  runId: string | null;
  deduplicated: boolean;
  childrenCreated: string[];
  childrenRan: string[];
  awaitingApproval: boolean;
  message: string;
}

@Injectable()
export class TaskRunnerService {
  private readonly logger = new Logger(TaskRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly ai: AiService,
    private readonly tasks: TasksService,
    private readonly runs: RunsService,
    private readonly tools: ToolExecutorService,
    private readonly planner: GmPlannerService,
    private readonly messages: MessagesService,
  ) {}

  async runTask(taskId: string, user: AuthUser, ctx: RequestContext, opts: RunTaskOptions = {}): Promise<RunTaskResult> {
    try {
      this.ai.assertReady();
    } catch (err) {
      if (err instanceof AiCredentialsError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }

    const cascade = opts.cascade ?? true;
    const maxDepth = opts.maxDepth ?? 2;

    const claimed = await this.claimTask(taskId, user);
    if (claimed.deduplicated) {
      return {
        task: claimed.task,
        runId: null,
        deduplicated: true,
        childrenCreated: [],
        childrenRan: [],
        awaitingApproval: claimed.task.status === 'AWAITING_APPROVAL',
        message: 'Task is already running or was claimed by another execution.',
      };
    }

    const outcome = await this.executeClaimed(claimed.task, user, ctx);
    const childrenCreated = outcome.childrenCreated;
    const childrenRan: string[] = [];

    if (cascade && maxDepth > 0 && childrenCreated.length && !outcome.awaitingApproval) {
      for (const childId of childrenCreated) {
        const child = await this.prisma.task.findUnique({ where: { id: childId }, select: { status: true } });
        if (!child || child.status !== 'QUEUED') continue;
        try {
          const nested = await this.runTask(childId, user, ctx, { cascade: true, maxDepth: maxDepth - 1 });
          childrenRan.push(childId);
          childrenCreated.push(...nested.childrenCreated);
          childrenRan.push(...nested.childrenRan);
        } catch (err) {
          // Child failures are recorded on the child; parent already finished its own turn.
          this.logger.warn(`Cascade run failed for child ${childId}: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
    }

    return {
      task: await this.tasks.get(taskId),
      runId: outcome.runId,
      deduplicated: false,
      childrenCreated: [...new Set(childrenCreated)],
      childrenRan: [...new Set(childrenRan)],
      awaitingApproval: outcome.awaitingApproval,
      message: outcome.message,
    };
  }

  private async claimTask(
    taskId: string,
    user: AuthUser,
  ): Promise<{ task: TaskDetail; deduplicated: boolean }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignedAgent: {
          select: {
            id: true,
            key: true,
            name: true,
            kind: true,
            role: true,
            instructions: true,
            tools: true,
            modelTier: true,
            modelOverride: true,
            maxOutputTokens: true,
            isEnabled: true,
            permissions: { select: { permission: true } },
          },
        },
        dependencies: { select: { dependsOn: { select: { status: true } } } },
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!task.assignedAgentId || !task.assignedAgent) {
      throw new BadRequestException('Task must be assigned to an agent before AI execution.');
    }
    if (!task.assignedAgent.isEnabled) {
      throw new BadRequestException(`${task.assignedAgent.name} is disabled.`);
    }
    if (task.status === 'CANCELLED') {
      throw new BadRequestException('Cancelled tasks cannot be executed.');
    }
    if (task.status === 'COMPLETED') {
      throw new BadRequestException('Completed tasks cannot be executed again.');
    }
    if (task.status === 'AWAITING_APPROVAL') {
      throw new BadRequestException('Task is waiting for CEO approval.');
    }
    if (task.status === 'RUNNING' || (await this.runs.hasActiveRun(taskId))) {
      return { task: await this.tasks.get(taskId), deduplicated: true };
    }
    if (task.status === 'FAILED') {
      if (task.attempts >= task.maxAttempts) {
        throw new BadRequestException(
          `Retry limit reached (${task.attempts}/${task.maxAttempts}). Raise maxAttempts before running again.`,
        );
      }
      // Re-queue then claim — reuses the existing state machine retry edge.
      await this.tasks.transitionAs(taskId, { to: 'QUEUED', message: 'Re-queued for AI retry' }, { type: 'USER', userId: user.id });
    }

    try {
      const running = await this.tasks.transitionAs(
        taskId,
        { to: 'RUNNING', message: 'AI execution started' },
        { type: 'AGENT', agentId: task.assignedAgentId, createdByUserId: user.id },
      );
      return { task: running, deduplicated: false };
    } catch (err) {
      if (err instanceof ConflictException) {
        return { task: await this.tasks.get(taskId), deduplicated: true };
      }
      throw err;
    }
  }

  private async executeClaimed(
    task: TaskDetail,
    user: AuthUser,
    _ctx: RequestContext,
  ): Promise<{ runId: string; childrenCreated: string[]; awaitingApproval: boolean; message: string }> {
    const agent = await this.prisma.agentDefinition.findUniqueOrThrow({
      where: { id: task.assignedAgentId! },
      select: {
        id: true,
        key: true,
        name: true,
        kind: true,
        role: true,
        instructions: true,
        tools: true,
        modelTier: true,
        modelOverride: true,
        maxOutputTokens: true,
        permissions: { select: { permission: true } },
        children: { select: { key: true, name: true, kind: true, isEnabled: true, role: true } },
      },
    });

    const modelName = this.config.resolveModel(agent.modelTier, agent.modelOverride) ?? 'unknown';

    const run = await this.runs.start({
      taskId: task.id,
      agentId: agent.id,
      provider: 'openai',
      model: modelName,
      input: {
        title: task.title,
        description: task.description,
        kind: task.kind,
        phase: CURRENT_EXECUTION_PHASE,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_CALL_TIMEOUT_MS);

    const actor: TaskActor = { type: 'AGENT', agentId: agent.id, createdByUserId: user.id };
    const childrenCreated: string[] = [];
    let awaitingApproval = false;
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      // Bail if cancelled while we were setting up.
      const latest = await this.prisma.task.findUnique({ where: { id: task.id }, select: { status: true } });
      if (!latest || latest.status === 'CANCELLED') {
        throw new AiCancelledError('Task was cancelled before the model call.');
      }

      const subordinates = agent.children
        .filter((c) => c.isEnabled)
        .map((c) => `- ${c.key} (${c.kind}): ${c.name} — ${c.role}`)
        .join('\n');

      const completion = await this.ai.completeStructured({
        tier: agent.modelTier,
        modelOverride: agent.modelOverride,
        maxOutputTokens: Math.min(agent.maxOutputTokens, 4000),
        schema: agentTurnSchema,
        schemaName: 'agent_turn',
        signal: controller.signal,
        messages: [
          {
            role: 'system',
            content: [
              `You are ${agent.name} (${agent.key}), a ${agent.kind.replace('_', ' ').toLowerCase()} in an AI automation company.`,
              `Role: ${agent.role}`,
              '',
              agent.instructions,
              '',
              'Rules:',
              `- Current product phase is ${CURRENT_EXECUTION_PHASE}. External email send, content publish, and paid campaign launch require CEO approval. Do not invent commitments, prices, campaign results, or final pricing.`,
              '- Never invent leads, contacts, budgets, or source URLs.',
              '- Prefer toolRequests for implemented tools only. request_send_outreach creates an approval — it does not send by itself.',
              '- For blocked capabilities, set result.outcome to "blocked" with clear blockedReasons.',
              '- findings[].invented must always be false.',
              subordinates ? `Direct reports you may delegate to:\n${subordinates}` : 'You have no direct reports.',
              `Configured tools: ${agent.tools.join(', ') || '(none)'}`,
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Execute this ${task.kind} task.`,
              `Title: ${task.title}`,
              `Description: ${task.description || '(none)'}`,
              `Task input JSON: ${JSON.stringify(task.input ?? {})}`,
              '',
              agent.kind === 'WORKER'
                ? 'Produce a worker result. If an authorized connector is not configured for this task, outcome must be "blocked" — do not fabricate findings. Manual import remains available to the CEO.'
                : 'Produce a plan with steps assigned to your direct reports, request delegate_task for each step, then submit_result summarizing the plan. List unavailable capabilities in blockedCapabilities.',
            ].join('\n'),
          },
        ],
      });

      usage = completion.usage;
      const turn = completion.data;
      this.assertHonestTurn(turn);

      if (turn.plan) {
        const planErrors = await this.planner.assertPlanAssignees(agent.id, turn.plan);
        if (planErrors.length) {
          throw new AiOutputValidationError(`Plan assignees are invalid: ${planErrors.join(' ')}`);
        }
      }

      const toolCtx: ToolExecutionContext = {
        runId: run.id,
        taskId: task.id,
        agentId: agent.id,
        agentKey: agent.key,
        agentTools: agent.tools,
        agentPermissions: agent.permissions.map((p) => p.permission),
        createdByUserId: user.id,
        parentTaskId: task.id,
      };

      // Ensure plan steps become delegate_task requests if the model only filled `plan`.
      const requests: ToolRequest[] = [...turn.toolRequests];
      if (turn.plan?.steps?.length) {
        for (const step of turn.plan.steps) {
          const already = requests.some(
            (r) => r.tool === 'delegate_task' && (r.stepKey === step.key || r.title === step.title),
          );
          if (!already) {
            requests.push({
              tool: 'delegate_task',
              title: step.title,
              description: step.description,
              assigneeAgentKey: step.assigneeAgentKey,
              stepKey: step.key,
              priority: step.priority,
            });
          }
        }
      }

      let submitted = false;
      let submitOutcome: WorkerResult['outcome'] | undefined;

      for (const req of requests) {
        const latestStatus = await this.prisma.task.findUnique({ where: { id: task.id }, select: { status: true } });
        if (latestStatus?.status === 'CANCELLED') throw new AiCancelledError('Task was cancelled during tool execution.');

        const result = await this.tools.execute(req.tool, toolRequestToArgs(req), toolCtx);
        if (result.createdTaskId) childrenCreated.push(result.createdTaskId);
        if (result.status === 'AWAITING_APPROVAL') {
          awaitingApproval = true;
          await this.tasks.transitionAs(
            task.id,
            { to: 'AWAITING_APPROVAL', message: result.errorMessage ?? 'Waiting for CEO approval' },
            actor,
          );
          break;
        }
        if (result.submitted) {
          submitted = true;
          submitOutcome = result.submitOutcome;
        }
      }

      if (!awaitingApproval && !submitted && turn.result) {
        const result = await this.tools.execute('submit_result', { result: turn.result }, toolCtx);
        if (result.submitted) {
          submitted = true;
          submitOutcome = result.submitOutcome;
        }
      }

      if (awaitingApproval) {
        await this.runs.succeed(run.id, { turn, childrenCreated, awaitingApproval: true }, usage);
        return { runId: run.id, childrenCreated, awaitingApproval: true, message: 'Paused for CEO approval.' };
      }

      if (!submitted) {
        // Synthesize a blocked/completed submit so the task does not stay RUNNING forever.
        const fallback: WorkerResult = turn.result ?? {
          summary: turn.plan
            ? `Planned ${turn.plan.steps.length} step(s). ${turn.plan.blockedCapabilities.join(' ') || ''}`.trim()
            : turn.notes || 'Agent finished without submit_result.',
          outcome: childrenCreated.length ? 'completed' : 'blocked',
          findings: [],
          blockedReasons: turn.plan?.blockedCapabilities?.length
            ? turn.plan.blockedCapabilities
            : childrenCreated.length
              ? []
              : ['Agent did not submit a structured result.'],
          nextActions: turn.plan?.steps?.map((s) => s.title) ?? [],
        };
        await this.tools.execute('submit_result', { result: fallback }, toolCtx);
        submitOutcome = fallback.outcome;
        submitted = true;
      }

      const output = { turn, childrenCreated, submitOutcome };
      await this.runs.succeed(run.id, output, usage);

      if (submitOutcome === 'blocked') {
        await this.tasks.transitionAs(
          task.id,
          {
            to: 'FAILED',
            message:
              turn.result?.blockedReasons?.join('; ') ||
              turn.plan?.blockedCapabilities?.join('; ') ||
              'Blocked: required capabilities are not available in this phase.',
          },
          actor,
        );
        return {
          runId: run.id,
          childrenCreated,
          awaitingApproval: false,
          message: 'Execution blocked — see task error message.',
        };
      }

      await this.tasks.transitionAs(
        task.id,
        {
          to: 'COMPLETED',
          message:
            submitOutcome === 'needs_review'
              ? 'Completed with items needing CEO review.'
              : childrenCreated.length
                ? `Completed; created ${childrenCreated.length} subtask(s).`
                : 'Completed.',
        },
        actor,
      );

      // Report back in Messages so the CEO sees a teammate update after work.
      const summary =
        turn.result?.summary?.trim() ||
        (childrenCreated.length ? `Created ${childrenCreated.length} subtask(s) for "${task.title}".` : `Finished "${task.title}".`);
      await this.messages
        .postFromAgent({
          agentId: task.assignedAgentId!,
          body: summary.slice(0, 4000),
          taskId: task.id,
          notify: true,
        })
        .catch((err) => this.logger.warn(`Team message after task ${task.id} failed: ${err instanceof Error ? err.message : err}`));

      return {
        runId: run.id,
        childrenCreated,
        awaitingApproval: false,
        message: 'AI execution completed.',
      };
    } catch (err) {
      const message = publicErrorMessage(err);
      await this.runs.fail(run.id, message, usage.totalTokens ? usage : null).catch(() => undefined);

      const latest = await this.prisma.task.findUnique({ where: { id: task.id }, select: { status: true } });
      if (latest?.status === 'CANCELLED') {
        return { runId: run.id, childrenCreated, awaitingApproval: false, message: 'Task was cancelled.' };
      }
      if (latest?.status === 'RUNNING') {
        try {
          await this.tasks.transitionAs(task.id, { to: 'FAILED', message }, actor);
        } catch {
          /* task may have been cancelled concurrently */
        }
      }

      if (err instanceof AiCredentialsError) throw new ServiceUnavailableException(err.message);
      if (err instanceof AiOutputValidationError) throw new BadRequestException(err.message);
      if (err instanceof AiCancelledError) throw new BadRequestException(err.message);
      if (err instanceof AiProviderError) throw new ServiceUnavailableException(err.message);
      if (err instanceof BadRequestException || err instanceof ConflictException || err instanceof NotFoundException) throw err;
      this.logger.error(`AI run failed for task ${task.id}: ${err instanceof Error ? err.name : typeof err}`);
      throw new ServiceUnavailableException(message);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertHonestTurn(turn: AgentTurn): void {
    if (turn.result?.findings?.some((f) => f.invented)) {
      throw new AiOutputValidationError('Model claimed invented findings; rejecting output.');
    }
  }
}

function publicErrorMessage(err: unknown): string {
  if (err instanceof AiCredentialsError) return err.message;
  if (err instanceof AiOutputValidationError) return err.message;
  if (err instanceof AiCancelledError) return err.message;
  if (err instanceof AiProviderError) return err.message;
  if (err instanceof BadRequestException) {
    const r = err.getResponse();
    if (typeof r === 'string') return r;
    if (typeof r === 'object' && r && 'message' in r) {
      const m = (r as { message: string | string[] }).message;
      return Array.isArray(m) ? m.join('; ') : String(m);
    }
  }
  return 'AI execution failed.';
}
