import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IntentLabel, LeadStage, OutreachChannel, OutreachStatus } from '../generated/prisma/enums';
import { PageQueryDto } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value;
const skills = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[;,]/).map((v) => v.trim()).filter(Boolean);
  return value;
};

export class CreateLeadDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) contactName?: string;
  @IsOptional() @Transform(trim) @IsEmail() @MaxLength(320) contactEmail?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) contactUrl?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) websiteUrl?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) country?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) industry?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) requirements?: string;
  @IsOptional() @Transform(skills) @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(80, { each: true }) requestedSkills?: string[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) budgetText?: string;
  @IsOptional() @IsEnum(LeadStage) stage?: LeadStage;
  @IsOptional() @IsUUID() assignedAgentId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) notes?: string;
  /** Original post/listing URL — required for provenance. */
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(2000) sourceUrl: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) externalId?: string;
  @IsOptional() @IsDateString() postDate?: string;
  @IsOptional() @IsDateString() discoveredAt?: string;
  /** Defaults to the seeded manual_import source. */
  @IsOptional() @IsUUID() sourceId?: string;
}

export class UpdateLeadDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) contactName?: string | null;
  @IsOptional() @Transform(trim) @IsEmail() @MaxLength(320) contactEmail?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) contactUrl?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) websiteUrl?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) country?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) industry?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) requirements?: string;
  @IsOptional() @Transform(skills) @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) requestedSkills?: string[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) budgetText?: string | null;
  @IsOptional() @IsUUID() assignedAgentId?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsBoolean() doNotContact?: boolean;
}

export class TransitionLeadDto {
  @IsEnum(LeadStage) to: LeadStage;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) message?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) lostReason?: string;
}

export class CriterionScoreDto {
  @Transform(trim) @IsString() key: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(100) score: number;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

export class ScoreLeadDto {
  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => CriterionScoreDto)
  criteria: CriterionScoreDto[];
}

export const LEAD_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'stage', 'latestScore', 'discoveredAt'] as const;
export type LeadSortField = (typeof LEAD_SORT_FIELDS)[number];

export class ListLeadsQueryDto extends PageQueryDto {
  @IsOptional() @Transform(csv) @IsArray() @IsEnum(LeadStage, { each: true }) stage?: LeadStage[];
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsUUID() assignedAgentId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) minScore?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) maxScore?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(LEAD_SORT_FIELDS) sortBy: LeadSortField = 'createdAt';
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() doNotContact?: boolean;
}

export class CsvImportPreviewDto {
  @IsString() @MinLength(1) @MaxLength(2_000_000) csv: string;
}

export class CsvImportConfirmDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CreateLeadDto)
  rows: CreateLeadDto[];
}

export class CreateOutreachDraftDto {
  @IsOptional() @IsEnum(OutreachChannel) channel?: OutreachChannel;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) subject?: string;
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(10_000) body: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) rationale?: string;
  @IsOptional() @IsBoolean() generateWithAi?: boolean;
}

export class UpdateOutreachDraftDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) subject?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MinLength(10) @MaxLength(10_000) body?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(5000) rationale?: string;
  @IsOptional() @IsEnum(OutreachStatus) status?: OutreachStatus;
}

export class GenerateOutreachDto {
  @IsOptional() @IsEnum(OutreachChannel) channel?: OutreachChannel;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) extraContext?: string;
}
