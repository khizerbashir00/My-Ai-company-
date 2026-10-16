import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { RunTaskDto } from './orchestration.dto';
import { TaskRunnerService } from './task-runner.service';

@Controller('orchestration')
export class OrchestrationController {
  constructor(private readonly runner: TaskRunnerService) {}

  /**
   * Run AI execution for a QUEUED (or retriable FAILED) task assigned to an agent.
   * Creates agent runs, validates tool calls against the registry, and emits SSE updates
   * through the existing task transition path.
   */
  @Roles(...WRITE_ROLES)
  @Post('tasks/:id/run')
  @HttpCode(200)
  run(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunTaskDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.runner.runTask(id, user, ctx, {
      cascade: dto.cascade,
      maxDepth: dto.maxDepth,
    });
  }
}
