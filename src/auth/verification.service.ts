import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfileService } from '../me/profile.service';
import { VerifyDto } from './dto/verify.dto';

@Injectable()
export class VerificationService {
  private readonly logger =
    new Logger(VerificationService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly profiles: ProfileService,
  ) {}

  async verify(input: VerifyDto) {
    const admin =
      this.supabase.createAdminClient();

    try {
      const {
        data: email,
        error: challengeError,
      } = await admin.rpc(
        'reserve_signup_attempt',
        {
          p_challenge_id:
            input.challengeId,
        },
      );

      if (challengeError) {
        throw new ServiceUnavailableException(
          'Verification is temporarily unavailable.',
        );
      }

      if (
        typeof email !== 'string' ||
        !email
      ) {
        throw new BadRequestException(
          'This verification request is invalid, expired, already used, or has no attempts remaining.',
        );
      }

      const client =
        this.supabase.createClient();

      const { data, error } =
        await client.auth.verifyOtp({
          email,
          token: input.code,
          type: 'email',
        });

      if (error) {
        if (error.status === 429) {
          throw new HttpException(
            'Too many verification attempts. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        if (
          !error.status ||
          error.status >= 500
        ) {
          throw new ServiceUnavailableException(
            'Unable to reach the authentication service.',
          );
        }

        throw new BadRequestException(
          'The verification code is invalid or expired.',
        );
      }

      if (
        !data.session ||
        !data.user
      ) {
        throw new ServiceUnavailableException(
          'Verification did not produce a session.',
        );
      }

      const session = data.session;
      const authUser = data.user;

      try {
        const {
          data: completed,
          error: completionError,
        } = await admin.rpc(
          'complete_signup_challenge',
          {
            p_challenge_id:
              input.challengeId,
          },
        );

        if (completionError) {
          throw new ServiceUnavailableException(
            'Unable to finish verification. Please try logging in.',
          );
        }

        if (completed !== true) {
          throw new BadRequestException(
            'This verification request has expired or was already used.',
          );
        }
      } catch (error: unknown) {
        /*
         * Never return an authenticated session when our own challenge
         * completion failed.
         */
        try {
          const {
            error: revokeError,
          } =
            await admin.auth.admin.signOut(
              session.access_token,
              'local',
            );

          if (revokeError) {
            this.logger.error(
              'Unable to revoke an undelivered session.',
            );
          }
        } catch {
          this.logger.error(
            'Session revocation service unavailable.',
          );
        }

        throw error;
      }

      const user =
        await this.profiles.getUser(
          authUser,
        );

      return {
        accessToken:
          session.access_token,
        refreshToken:
          session.refresh_token,
        user,
      };
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Verification is temporarily unavailable. Please try again later.',
      );
    }
  }
}