import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { CreateTaskDto, ListTasksQueryDto, TransitionTaskDto, UpdateTaskDto } from './tasks.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Query() q: ListTasksQueryDto) {
    return this.tasks.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.get(id);
  }

  /** 201 for a new task, 200 when an idempotency key matched an existing one. */
  @Roles(...WRITE_ROLES)
  @Post()
  async create(@Body() dto: CreateTaskDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.tasks.create(dto, user, ctx);
    res.status(result.deduplicated ? 200 : 201);
    return result;
  }

  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.tasks.update(id, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/transition')
  @HttpCode(200)
  transition(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionTaskDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.tasks.transition(id, dto, user, ctx);
  }
}
