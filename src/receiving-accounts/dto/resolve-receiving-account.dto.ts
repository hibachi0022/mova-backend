import { Transform } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResolveReceivingAccountDto {
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
  @IsIn([
    'NG',
  ])
  country!: string;

  @Transform(
    ({
      value,
    }: {
      value:
        unknown;
    }) =>
      typeof value ===
        'string'
        ? value.trim()
        : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(
    /^[A-Za-z0-9_-]+$/,
    {
      message:
        'bankCode contains invalid characters',
    },
  )
  bankCode!: string;

  @Transform(
    ({
      value,
    }: {
      value:
        unknown;
    }) =>
      typeof value ===
        'string'
        ? value.trim()
        : value,
  )
  @IsString()
  @Matches(
    /^[0-9]{10}$/,
    {
      message:
        'accountNumber must be a 10 digit Nigerian account number',
    },
  )
  accountNumber!: string;

  @IsOptional()
  @IsObject()
  routingDetails?:
    Record<
      string,
      string
    >;
}