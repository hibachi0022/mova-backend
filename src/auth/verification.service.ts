import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { VerifyDto } from './dto/verify.dto';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async verify(input: VerifyDto) {
    const admin = this.supabase.createAdminClient();

    try {
      const { data: email, error: challengeError } = await admin.rpc(
        'reserve_signup_attempt',
        {
          p_challenge_id: input.challengeId,
        },
      );

      if (challengeError) {
        throw new ServiceUnavailableException(
          'Verification is temporarily unavailable.',
        );
      }

      if (typeof email !== 'string' || !email) {
        throw new BadRequestException(
          'This verification request is invalid, expired, already used, or has no attempts remaining.',
        );
      }

      const client = this.supabase.createClient();

      const { data, error } = await client.auth.verifyOtp({
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

        if (!error.status || error.status >= 500) {
          throw new ServiceUnavailableException(
            'Unable to reach the authentication service.',
          );
        }

        throw new BadRequestException(
          'The verification code is invalid or expired.',
        );
      }

      if (!data.session || !data.user) {
        throw new ServiceUnavailableException(
          'Verification did not produce a session.',
        );
      }

      const session = data.session;
      const user = data.user;

      try {
        const { data: completed, error: completionError } =
          await admin.rpc('complete_signup_challenge', {
            p_challenge_id: input.challengeId,
          });

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
        // Do not return a session if challenge completion failed.
        try {
          const { error: revokeError } = await admin.auth.admin.signOut(
            session.access_token,
            'local',
          );

          if (revokeError) {
            this.logger.error('Unable to revoke an undelivered session.');
          }
        } catch {
          this.logger.error('Session revocation service unavailable.');
        }

        throw error;
      }

      const displayName: unknown = user.user_metadata.display_name;

      return {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        user: {
          id: user.id,
          email: user.email ?? email,
          displayName:
            typeof displayName === 'string' ? displayName : '',
        },
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