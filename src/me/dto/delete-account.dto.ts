import {
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class DeleteAccountDto {
  /*
   * Current passwords may belong to accounts created before the current
   * 12-character password policy, so we only require a non-empty string.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
}