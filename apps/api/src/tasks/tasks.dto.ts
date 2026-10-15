import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { TaskKind, TaskPriority, TaskStatus } from '../generated/prisma/enums';
import { PageQueryDto } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value;

export class CreateTaskDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsEnum(TaskKind) kind?: TaskKind;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() assignedAgentId?: string;
  @IsOptional() @IsUUID() parentTaskId?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) maxAttempts?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) dependsOn?: string[];
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) idempotencyKey?: string;
  @IsOptional() @IsObject() input?: Record<string, unknown>;
}

export class UpdateTaskDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  /** null clears the deadline */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueAt?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) maxAttempts?: number;
}

export class TransitionTaskDto {
  @IsEnum(TaskStatus) to: TaskStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) message?: string;
}

export const TASK_SORT_FIELDS = ['createdAt', 'updatedAt', 'dueAt', 'priority', 'title', 'status'] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export class ListTasksQueryDto extends PageQueryDto {
  @IsOptional() @Transform(csv) @IsArray() @IsEnum(TaskStatus, { each: true }) status?: TaskStatus[];
  @IsOptional() @IsEnum(TaskKind) kind?: TaskKind;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() assignedAgentId?: string;
  /** A task ID, or "root" for top-level tasks only */
  @IsOptional() @ValidateIf((_, v) => v !== 'root') @IsUUID() parentTaskId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(TASK_SORT_FIELDS) sortBy: TaskSortField = 'createdAt';
}
