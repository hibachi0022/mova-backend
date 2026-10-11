import {
  IsUUID,
} from 'class-validator';

export class TransferCheckoutDto {
  @IsUUID(
    '4',
  )
  quoteId!: string;
}