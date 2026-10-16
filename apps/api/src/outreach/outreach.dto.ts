import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class RequestSendDto {
  /** Optional override; defaults to lead.contactEmail. Must be a verified authorized contact. */
  @IsOptional() @IsString() @MaxLength(320) recipientEmail?: string;
}

export class DecideApprovalDto {
  @IsIn(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class ScheduleFollowUpDto {
  @IsDateString() scheduledFor!: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @IsString() @MinLength(10) @MaxLength(10_000) body!: string;
  @IsOptional() @IsString() @MaxLength(5000) rationale?: string;
  @IsOptional() @IsUUID() parentMessageId?: string;
}

export class ConfirmDealDto {
  @IsString() @MinLength(10) @MaxLength(5000) scope!: string;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000_000) dealValue!: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(200) projectName?: string;
}

export class IngestReplyDto {
  @IsString() @MinLength(3) @MaxLength(320) fromEmail!: string;
  @IsOptional() @IsString() @MaxLength(320) toEmail?: string;
  @IsOptional() @IsString() @MaxLength(500) subject?: string;
  @IsString() @MaxLength(50_000) bodyText!: string;
  @IsString() @MinLength(1) @MaxLength(200) providerMessageId!: string;
  @IsOptional() @IsString() @MaxLength(200) inReplyTo?: string;
}

export class ListApprovalsQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number = 20;
}
