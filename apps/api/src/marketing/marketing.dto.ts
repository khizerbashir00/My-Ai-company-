import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CampaignAssetType,
  CampaignStatus,
  ContentChannel,
  ContentItemStatus,
  FindingKind,
  MarketingReportPeriod,
  ResearchProjectStatus,
} from '../generated/prisma/client';

export class UpsertBrandProfileDto {
  @IsOptional() @IsString() @MaxLength(10_000) voiceGuidelines?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) servicesOffered?: string[];
  @IsOptional() @IsString() @MaxLength(10_000) portfolioNotes?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) approvedClaims?: string[];
}

export class CreateResearchProjectDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsString() @MinLength(2) @MaxLength(100) country!: string;
  @IsString() @MinLength(2) @MaxLength(100) industry!: string;
  @IsString() @MinLength(2) @MaxLength(200) serviceOffering!: string;
  @IsOptional() @IsString() @MaxLength(2000) targetCustomerProfile?: string;
  @IsOptional() @IsEnum(ResearchProjectStatus) status?: ResearchProjectStatus;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class FindingInputDto {
  @IsString() @MinLength(3) @MaxLength(2000) claim!: string;
  @IsEnum(FindingKind) kind!: FindingKind;
  @IsOptional() @IsString() @MaxLength(2000) evidenceUrl?: string;
  @IsOptional() @IsString() @MaxLength(1000) sourceNote?: string;
  @IsOptional() @IsDateString() researchedAt?: string;
}

export class CreateCompetitorReportDto {
  @IsString() @MinLength(2) @MaxLength(200) competitorName!: string;
  @IsOptional() @IsString() @MaxLength(10_000) summary?: string;
  @IsOptional() @IsDateString() researchedAt?: string;
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => FindingInputDto)
  findings!: FindingInputDto[];
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) sourceUrls!: string[];
}

export class CreateContentItemDto {
  @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @IsEnum(ContentChannel) channel!: ContentChannel;
  @IsOptional() @IsDateString() scheduledFor?: string;
  @IsOptional() @IsUUID() campaignId?: string;
  @IsOptional() @IsEnum(ContentItemStatus) status?: ContentItemStatus;
}

export class CreateContentDraftDto {
  @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @IsString() @MinLength(10) @MaxLength(50_000) body!: string;
  @IsOptional() @IsString() @MaxLength(2000) changeNote?: string;
  @IsOptional() @IsBoolean() useBrandProfile?: boolean;
}

export class CreateCampaignDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) objective?: string;
  @IsOptional() @IsString() @MaxLength(100) channel?: string;
  @IsOptional() @IsString() @MaxLength(2000) audience?: string;
  @IsOptional() @IsString() @MaxLength(5000) messaging?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) industries?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) countries?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000_000) budgetRecommendation?: number;
  @IsOptional() @IsString() @MaxLength(8) budgetCurrency?: string;
  @IsOptional() @IsBoolean() isPaid?: boolean;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() successMetrics?: Record<string, unknown>;
}

export class CreateCampaignAssetDto {
  @IsEnum(CampaignAssetType) type!: CampaignAssetType;
  @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @IsString() @MinLength(10) @MaxLength(50_000) content!: string;
  @IsOptional() @IsDateString() scheduledFor?: string;
}

export class UpdateCampaignAssetDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(50_000) content?: string;
  @IsOptional() @IsString() @MaxLength(2000) changeNote?: string;
}

export class MetricRowDto {
  @IsString() @MinLength(1) @MaxLength(80) metricKey!: string;
  @Type(() => Number) @IsNumber() value!: number;
  @IsOptional() @Type(() => Number) @IsNumber() denominator?: number;
  @IsOptional() @IsString() @MaxLength(120) denominatorLabel?: string;
  @IsOptional() @IsDateString() periodStart?: string;
  @IsOptional() @IsDateString() periodEnd?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ImportCampaignMetricsDto {
  @IsOptional() @IsUUID() campaignId?: string;
  @IsString() @MinLength(2) @MaxLength(120) sourceName!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MetricRowDto)
  rows!: MetricRowDto[];
}

export class GenerateMarketingReportDto {
  @IsEnum(MarketingReportPeriod) period!: MarketingReportPeriod;
  @IsOptional() @IsDateString() asOf?: string;
}

export class AttributeLeadDto {
  @IsUUID() leadId!: string;
  @IsOptional() @IsUUID() campaignId?: string | null;
}

export class UpdateCampaignStatusDto {
  @IsEnum(CampaignStatus) status!: CampaignStatus;
}
