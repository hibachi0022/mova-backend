import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from './auth.guard';
import { RefreshDto } from './dto/refresh.dto';
import { SessionService } from './session.service';

@Controller('auth')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
    },
  })
  refresh(@Body() input: RefreshDto) {
    return this.sessionService.refresh(input);
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async logout(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);

    if (!match) {
      throw new UnauthorizedException('A bearer access token is required.');
    }

    await this.sessionService.logout(match[1]);
  }
}