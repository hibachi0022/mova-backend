import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SaveReceivingAccountDto {
  @IsUUID(
    '4',
  )
  verificationId!: string;

  @IsOptional()
  @Transform(
    ({
      value,
    }: {
      value:
        unknown;
    }) =>
      typeof value ===
        'string'
        ? value
            .trim()
            .toUpperCase()
        : value,
  )
  @IsString()
  @MinLength(
    1,
  )
  @MaxLength(
    6,
  )
  @Matches(
    /^\p{L}+$/u,
    {
      message:
        'initials may contain letters only',
    },
  )
  initials?: string;
}