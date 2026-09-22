import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ResendDto } from './dto/resend.dto';
import { ResendService } from './resend.service';

@Controller('auth')
export class ResendController {
  constructor(private readonly resendService: ResendService) {}

  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 3,
      ttl: 60_000,
    },
  })
  resend(@Body() input: ResendDto) {
    return this.resendService.resend(input);
  }
}