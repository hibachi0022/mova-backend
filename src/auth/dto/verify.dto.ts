import { IsString, IsUUID, Matches } from 'class-validator';

export class VerifyDto {
  @IsUUID('4')
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'code must contain exactly six digits',
  })
  code!: string;
}