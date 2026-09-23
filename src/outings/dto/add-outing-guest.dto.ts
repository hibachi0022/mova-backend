import {
  Transform,
} from 'class-transformer';
import {
  Equals,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AddOutingGuestDto {
  @Transform(
    ({ value }) =>
      typeof value === 'string'
        ? value.trim()
        : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName!: string;

  /*
   * The existing mobile client sends
   * optedIn: false when adding a guest.
   *
   * Guests cannot be opted into payer
   * selection by the host, so true is
   * deliberately rejected.
   */
  @IsOptional()
  @Equals(false)
  optedIn?: false;
}