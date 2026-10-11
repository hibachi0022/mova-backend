import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateTransferQuoteDto {
  @IsUUID(
    '4',
  )
  recipientId!: string;

  @IsUUID(
    '4',
  )
  paymentMethodId!: string;

  @IsInt()
  @Min(
    1,
  )
  @Max(
    Number.MAX_SAFE_INTEGER,
  )
  amountMinor!: number;

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
    'NGN',
  ])
  currency!: 'NGN';
}