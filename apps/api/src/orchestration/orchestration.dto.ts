import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

const toBool = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

export class RunTaskDto {
  /** Run newly created child tasks too (default true). */
  @IsOptional() @Transform(toBool) @IsBoolean() cascade?: boolean;
  /** Max cascade depth; goal→manager→worker needs 2. */
  @IsOptional() @IsInt() @Min(0) @Max(3) maxDepth?: number;
}
