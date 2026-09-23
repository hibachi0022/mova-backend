import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SocialSettingsDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.trim().toLowerCase()
      : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[a-z0-9_]+$/, {
    message:
      'username may contain only lowercase letters, numbers and underscores',
  })
  username?: string;

  @IsOptional()
  @IsBoolean()
  isDiscoverable?: boolean;
}