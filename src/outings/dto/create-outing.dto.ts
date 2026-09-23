import {
  Transform,
} from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateOutingDto {
  @Transform(
    ({ value }) =>
      typeof value === 'string'
        ? value.trim()
        : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  @Transform(
    ({ value }) =>
      typeof value === 'string'
        ? value.trim()
        : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  location!: string;

  @IsISO8601({
    strict: true,
  })
  startsAt!: string;

  @Transform(
    ({ value }) =>
      typeof value === 'string'
        ? value
            .trim()
            .toUpperCase()
        : value,
  )
  @IsString()
  @Matches(
    /^[A-Z]{3}$/,
  )
  currency!: string;

  @IsInt()
  @Min(0)
  @Max(
    Number.MAX_SAFE_INTEGER,
  )
  amountMinor!: number;
}