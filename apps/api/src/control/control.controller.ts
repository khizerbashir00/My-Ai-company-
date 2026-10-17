import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { ControlService } from './control.service';

/**
 * Company-wide controls. Every action performs real backend work (workflow switches persisted in the DB,
 * BullMQ worker pause/resume, AI runs aborted, tasks re-queued through the state machine) and is audited.
 */
@Controller('control')
export class ControlController {
  constructor(private readonly control: ControlService) {}

  /** Live snapshot of workflows, agents, people, jobs, social connections and the operations log. */
  @Get('status')
  status() {
    return this.control.status();
  }

  @Roles(...WRITE_ROLES)
  @Post('start-all')
  @HttpCode(200)
  startAll(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.control.startAll(user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('stop-all')
  @HttpCode(200)
  stopAll(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.control.stopAll(user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('restart-failed')
  @HttpCode(200)
  restartFailed(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.control.restartFailed(user, ctx);
  }

  /** Connecting company social accounts is CEO-only, like the per-platform Connect button. */
  @Roles('CEO')
  @Post('connect-all')
  @HttpCode(200)
  connectAll(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.control.connectAll(user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('workflows/:key/start')
  @HttpCode(200)
  start(@Param('key') key: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.control.setWorkflow(key, true, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('workflows/:key/stop')
  @HttpCode(200)
  stop(@Param('key') key: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.control.setWorkflow(key, false, user, ctx);
  }
}
