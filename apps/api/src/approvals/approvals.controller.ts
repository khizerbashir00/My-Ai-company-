import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { DecideApprovalDto, ListApprovalsQueryDto } from '../outreach/outreach.dto';
import { ApprovalsService } from './approvals.service';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@Query() q: ListApprovalsQueryDto) {
    return this.approvals.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(id);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/decide')
  @HttpCode(200)
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideApprovalDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.approvals.decide(id, dto, user, ctx);
  }
}
