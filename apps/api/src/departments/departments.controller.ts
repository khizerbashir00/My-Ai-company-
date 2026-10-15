import { Controller, Get, Param } from '@nestjs/common';
import { DepartmentsService } from './departments.service';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  list() {
    return this.departments.list();
  }

  @Get('org-chart')
  orgChart() {
    return this.departments.orgChart();
  }

  /** Accepts a department ID or its key (e.g. "sales"). */
  @Get(':idOrKey')
  get(@Param('idOrKey') idOrKey: string) {
    return this.departments.get(idOrKey);
  }
}
