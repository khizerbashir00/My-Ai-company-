import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateConnectionDto {
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  /** Non-secret connector config (query, tags, maxResults, …). */
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_080) scanIntervalMinutes?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class ListScanRunsQueryDto {
  @IsOptional() @IsString() connectionId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number = 20;
}

export class ManualImportLeadDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @IsOptional() @IsString() @MaxLength(320) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(500) contactUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) websiteUrl?: string;
  @IsOptional() @IsString() @MaxLength(5000) requirements?: string;
  @IsOptional() requestedSkills?: string[];
  @IsOptional() @IsString() @MaxLength(200) budgetText?: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsString() @MinLength(8) @MaxLength(2000) sourceUrl!: string;
  @IsOptional() @IsString() @MaxLength(200) externalId?: string;
  @IsOptional() @IsString() postDate?: string;
}
