import { Transform } from 'class-transformer';
import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SearchFriendsDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.trim()
      : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(
    /^[\p{L}\p{N}_ .'-]+$/u,
    {
      message:
        'q contains unsupported characters',
    },
  )
  q!: string;
}