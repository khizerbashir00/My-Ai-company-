import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles } from '../common/auth.decorators';
import { ListAgentsQueryDto, SetPermissionsDto, UpdateAgentDto } from './agents.dto';
import { AgentsService } from './agents.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** The catalog of tools and permissions that can ever be assigned to agents. */
  @Get('registry')
  registry() {
    return this.agents.registry();
  }

  @Get()
  list(@Query() q: ListAgentsQueryDto) {
    return this.agents.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.get(id);
  }

  /** Agent configuration is a CEO decision. */
  @Roles('CEO')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgentDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.agents.update(id, dto, user, ctx);
  }

  @Roles('CEO')
  @Put(':id/permissions')
  setPermissions(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPermissionsDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.agents.setPermissions(id, dto, user, ctx);
  }
}
