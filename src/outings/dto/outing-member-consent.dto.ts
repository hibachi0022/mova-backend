import {
  IsBoolean,
} from 'class-validator';

export class OutingMemberConsentDto {
  @IsBoolean()
  optedIn!: boolean;
}