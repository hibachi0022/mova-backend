import {
  Transform,
} from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class JoinOutingDto {
  /*
   * Kept for compatibility with the
   * current mobile client.
   *
   * For a registered MOVA account,
   * the profile display name remains
   * authoritative.
   */
  @Transform(
    ({ value }) =>
      typeof value === 'string'
        ? value.trim()
        : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName?: string;
}