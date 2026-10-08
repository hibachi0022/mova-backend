import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
} from 'class-validator';

export class BanksQueryDto {
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
}