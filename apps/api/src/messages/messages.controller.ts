import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { PostTeamMessageDto } from './messages.dto';
import { MessagesService } from './messages.service';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('agents')
  agents() {
    return this.messages.listAgents();
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.messages.listThreads(user.id);
  }

  @Get(':threadId')
  get(@CurrentUser() user: AuthUser, @Param('threadId', ParseUUIDPipe) threadId: string) {
    return this.messages.getThread(user.id, threadId);
  }

  @Roles(...WRITE_ROLES)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: PostTeamMessageDto) {
    return this.messages.postAsCeo(user, dto);
  }

  @Roles(...WRITE_ROLES)
  @Post(':threadId')
  reply(
    @CurrentUser() user: AuthUser,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: PostTeamMessageDto,
  ) {
    return this.messages.postAsCeo(user, dto, threadId);
  }
}
