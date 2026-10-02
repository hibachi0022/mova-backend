import {
  IsUUID,
} from 'class-validator';

export class OutingSavedCardChargeDto {
  @IsUUID()
  paymentMethodId!:
    string;
}