import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';

type ResetRequestReservation = {
  status: 'ready' | 'cooldown' | 'invalid';
  challengeId?: string;
  email?: string;
};

type ResetAttemptReservation = {
  status: 'ready' | 'invalid';
  challengeId?: string;
  email?: string;
};

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async request(input: PasswordResetRequestDto) {
    try {
      const admin = this.supabase.createAdminClient();

      const { data, error: reservationError } = await admin.rpc(
        'reserve_password_reset_request',
        {
          p_email: input.email,
        },
      );

      if (reservationError || !data) {
        throw new ServiceUnavailableException(
          'Password reset is temporarily unavailable.',
        );
      }

      const reservation = data as ResetRequestReservation;

      if (reservation.status === 'cooldown') {
        throw new HttpException(
          'Please wait 60 seconds before requesting another reset code.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (reservation.status === 'invalid') {
        throw new BadRequestException(
          'A new password reset cannot be requested for this email right now. Please try again later.',
        );
      }

      if (
        reservation.status !== 'ready' ||
        typeof reservation.challengeId !== 'string' ||
        !reservation.challengeId ||
        typeof reservation.email !== 'string' ||
        !reservation.email
      ) {
        throw new ServiceUnavailableException(
          'Password reset is temporarily unavailable.',
        );
      }

      const client = this.supabase.createClient();

      const { error } = await client.auth.resetPasswordForEmail(
        reservation.email,
      );

      if (error) {
        if (error.status === 429) {
          throw new HttpException(
            'Password reset email sending is rate limited. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        /*
         * Keep provider failures generic.
         *
         * resetPasswordForEmail() intentionally does not reveal whether
         * an account exists for the supplied email address, and our API
         * must preserve that property.
         */
        throw new ServiceUnavailableException(
          'Unable to request a password reset right now. Please try again later.',
        );
      }

      return {
        message:
          'If an account matches this email, a reset code has been requested.',
      };
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Password reset is temporarily unavailable. Please try again later.',
      );
    }
  }

  async confirm(input: PasswordResetConfirmDto) {
    const admin = this.supabase.createAdminClient();

    try {
      /*
       * Reserve an application-level verification attempt first.
       *
       * This makes the five-attempt budget atomic even when several
       * confirmation requests arrive at the same time.
       */
      const { data, error: reservationError } = await admin.rpc(
        'reserve_password_reset_attempt',
        {
          p_email: input.email,
        },
      );

      if (reservationError || !data) {
        throw new ServiceUnavailableException(
          'Password reset verification is temporarily unavailable.',
        );
      }

      const reservation = data as ResetAttemptReservation;

      if (
        reservation.status !== 'ready' ||
        typeof reservation.challengeId !== 'string' ||
        !reservation.challengeId ||
        typeof reservation.email !== 'string' ||
        !reservation.email
      ) {
        throw new BadRequestException(
          'This password reset request is invalid, expired, already used, or has no attempts remaining.',
        );
      }

      const client = this.supabase.createClient();

      /*
       * This MUST be "recovery".
       *
       * A signup/email-verification OTP must never authorize a password
       * reset.
       */
      const { data: verification, error: verificationError } =
        await client.auth.verifyOtp({
          email: reservation.email,
          token: input.code,
          type: 'recovery',
        });

      if (verificationError) {
        if (verificationError.status === 429) {
          throw new HttpException(
            'Too many password reset attempts. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        if (
          !verificationError.status ||
          verificationError.status >= 500
        ) {
          throw new ServiceUnavailableException(
            'Unable to reach the authentication service.',
          );
        }

        throw new BadRequestException(
          'The password reset code is invalid or expired.',
        );
      }

      if (!verification.session || !verification.user) {
        throw new ServiceUnavailableException(
          'Password reset verification did not produce a recovery session.',
        );
      }

      const recoverySession = verification.session;
      const recoveryUser = verification.user;

      /*
       * Finish the application's reset challenge before changing the
       * password.
       *
       * If this database completion fails, we do NOT update the password.
       * The short-lived recovery session is revoked below instead.
       *
       * If password updating later fails after this point, the challenge
       * has already been consumed. The user can safely request a fresh
       * reset code and retry rather than accidentally reusing the verified
       * challenge.
       */
      const { data: completed, error: completionError } =
        await admin.rpc('complete_password_reset_challenge', {
          p_challenge_id: reservation.challengeId,
        });

      if (completionError) {
        await this.revokeRecoverySession(
          recoverySession.access_token,
          'local',
        );

        throw new ServiceUnavailableException(
          'Unable to complete password reset verification. Please request a new reset code.',
        );
      }

      if (completed !== true) {
        await this.revokeRecoverySession(
          recoverySession.access_token,
          'local',
        );

        throw new BadRequestException(
          'This password reset request has expired or was already used.',
        );
      }

      /*
       * The recovery OTP has now authenticated the account owner.
       *
       * Updating by user ID is performed only on the trusted backend with
       * the server-only Supabase secret key. The user ID comes directly
       * from Supabase's successful recovery verification response.
       */
      const { error: updateError } =
        await admin.auth.admin.updateUserById(recoveryUser.id, {
          password: input.newPassword,
        });

      if (updateError) {
        await this.revokeRecoverySession(
          recoverySession.access_token,
          'local',
        );

        if (updateError.status === 429) {
          throw new HttpException(
            'Too many password reset attempts. Please request a new reset code and try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        if (updateError.code === 'weak_password') {
          throw new UnprocessableEntityException(
            'Choose a stronger password. Request a new reset code before trying again.',
          );
        }

        if (!updateError.status || updateError.status >= 500) {
          throw new ServiceUnavailableException(
            'Unable to update the password. Please request a new reset code and try again.',
          );
        }

        throw new UnprocessableEntityException(
          'Unable to use that password. Request a new reset code and choose a different password.',
        );
      }

      /*
       * A password reset should require fresh authentication everywhere.
       *
       * Ask Supabase to revoke refresh tokens for every session belonging
       * to this user. Existing short-lived access JWTs may remain valid
       * until their normal expiry, which is a Supabase/JWT property.
       *
       * Password changes are already security-sensitive Auth events, so
       * failure of this extra revocation request must not make us tell the
       * user their password was not changed when it actually was.
       */
      try {
        const { error: signOutError } =
          await admin.auth.admin.signOut(
            recoverySession.access_token,
            'global',
          );

        if (signOutError) {
          this.logger.warn(
            'Password was updated, but explicit global session revocation returned an error.',
          );
        }
      } catch {
        this.logger.warn(
          'Password was updated, but explicit global session revocation was unavailable.',
        );
      }

      return {
        message:
          'Password updated. Sign in again with your new password.',
      };
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Password reset is temporarily unavailable. Please try again later.',
      );
    }
  }

  private async revokeRecoverySession(
    accessToken: string,
    scope: 'local' | 'global',
  ): Promise<void> {
    try {
      const admin = this.supabase.createAdminClient();

      const { error } = await admin.auth.admin.signOut(
        accessToken,
        scope,
      );

      if (error) {
        this.logger.warn(
          'Unable to revoke an unused password recovery session.',
        );
      }
    } catch {
      this.logger.warn(
        'Password recovery session revocation service was unavailable.',
      );
    }
  }
}