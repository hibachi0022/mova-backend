import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { LoginService } from './auth/login.service';
import { PasswordResetController } from './auth/password-reset.controller';
import { PasswordResetService } from './auth/password-reset.service';
import { ResendController } from './auth/resend.controller';
import { ResendService } from './auth/resend.service';
import { SessionController } from './auth/session.controller';
import { SessionService } from './auth/session.service';
import { VerificationService } from './auth/verification.service';
import { MeController } from './me/me.controller';
import { ProfileService } from './me/profile.service';
import { SupabaseService } from './supabase/supabase.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 60,
      },
    ]),
  ],
  controllers: [
    AppController,
    AuthController,
    SessionController,
    ResendController,
    PasswordResetController,
    MeController,
  ],
  providers: [
    AppService,
    SupabaseService,
    ProfileService,
    AuthService,
    LoginService,
    VerificationService,
    SessionService,
    ResendService,
    PasswordResetService,
    AuthGuard,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}