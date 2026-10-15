import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(200)
  currentPassword: string;

  @IsString()
  @MinLength(12, { message: 'New password must be at least 12 characters' })
  @MaxLength(200)
  newPassword: string;
}
