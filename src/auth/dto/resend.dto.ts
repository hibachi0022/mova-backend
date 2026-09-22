import { IsUUID } from 'class-validator';

export class ResendDto {
  @IsUUID('4')
  challengeId!: string;
}