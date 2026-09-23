import {
  IsIn,
  IsString,
} from 'class-validator';

export const OUTING_PAYMENT_METHOD_IDS = [
  'nfc',
  'apple_pay',
  'google_pay',
  'paypal',
  'bank_transfer',
  'card',
] as const;

export type OutingPaymentMethodId =
  (typeof OUTING_PAYMENT_METHOD_IDS)[number];

export class OutingCheckoutDto {
  @IsString()
  @IsIn(
    OUTING_PAYMENT_METHOD_IDS,
  )
  methodId!:
    OutingPaymentMethodId;
}