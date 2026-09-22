import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetService } from './password-reset.service';

@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(
    private readonly passwordResetService: PasswordResetService,
  ) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 3,
      ttl: 60_000,
    },
  })
  request(@Body() input: PasswordResetRequestDto) {
    return this.passwordResetService.request(input);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  confirm(@Body() input: PasswordResetConfirmDto) {
    return this.passwordResetService.confirm(input);
  }
}