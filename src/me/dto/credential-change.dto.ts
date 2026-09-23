import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CredentialChangeDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.trim().toLowerCase()
      : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /*
   * Existing users may have passwords created before the current
   * 12-character policy, so currentPassword deliberately does not enforce
   * the new-password minimum.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword?: string;
}