import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AgentKind, ModelTier } from '../generated/prisma/enums';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ListAgentsQueryDto {
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsEnum(AgentKind) kind?: AgentKind;
}

export class UpdateAgentDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) role?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(20) @MaxLength(8000) instructions?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) reportingResponsibilities?: string;
  @IsOptional() @IsBoolean() isEnabled?: boolean;
  @IsOptional() @IsEnum(ModelTier) modelTier?: ModelTier;
  /** A model ID available to your API project, or null to use the tier's configured model */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9._:\-/]{1,100}$/, { message: 'modelOverride must be a model ID (letters, digits, . _ : - /)' })
  modelOverride?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(32000) maxOutputTokens?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) tools?: string[];
}

export class PermissionGrantDto {
  @IsString() @MaxLength(100) permission: string;
  @IsBoolean() requiresApproval: boolean;
}

export class SetPermissionsDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => PermissionGrantDto) permissions: PermissionGrantDto[];
}
