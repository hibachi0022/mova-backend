import { IsString, Matches, MaxLength } from 'class-validator';

export class RefreshDto {
  @IsString()
  @Matches(/^\S+$/, {
    message: 'refreshToken must be a non-empty token without spaces',
  })
  @MaxLength(4096)
  refreshToken!: string;
}