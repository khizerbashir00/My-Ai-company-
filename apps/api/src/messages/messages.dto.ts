import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class PostTeamMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  /** Required when starting a new thread (no :threadId). Ignored when posting into an existing thread. */
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
}
