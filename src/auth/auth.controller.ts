import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from './auth.guard';
import type { AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { LoginService } from './login.service';
import { VerificationService } from './verification.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { VerifyDto } from './dto/verify.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly verificationService: VerificationService,
    private readonly loginService: LoginService,
  ) {}

  @Post('signup')
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 3,
      ttl: 60_000,
    },
  })
  signup(@Body() input: SignupDto) {
    return this.authService.signup(input);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  verify(@Body() input: VerifyDto) {
    return this.verificationService.verify(input);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  login(@Body() input: LoginDto) {
    return this.loginService.login(input);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() request: AuthenticatedRequest) {
    const user = request.authUser;
    const displayName: unknown = user.user_metadata.display_name;

    return {
      user: {
        id: user.id,
        email: user.email ?? '',
        displayName:
          typeof displayName === 'string' ? displayName : '',
      },
    };
  }
}