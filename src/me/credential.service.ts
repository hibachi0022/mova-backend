import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { CredentialChangeDto } from './dto/credential-change.dto';

export type CredentialChangeResult =
  | {
      status: 'confirmation_required';
      passwordUpdated?: true;
    }
  | {
      status: 'password_updated';
    };

@Injectable()
export class CredentialService {
  private readonly logger =
    new Logger(CredentialService.name);

  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  async change(
    authUser: User,
    input: CredentialChangeDto,
  ): Promise<CredentialChangeResult> {
    const currentEmail =
      authUser.email?.trim().toLowerCase();

    if (!currentEmail) {
      throw new BadRequestException(
        'This account does not have an email address that can be updated.',
      );
    }

    const emailChanged =
      input.email !== currentEmail;

    const passwordChanged =
      typeof input.newPassword === 'string';

    if (!emailChanged && !passwordChanged) {
      throw new BadRequestException(
        'Enter a new email address or password.',
      );
    }

    if (
      passwordChanged &&
      input.newPassword === input.currentPassword
    ) {
      throw new BadRequestException(
        'Your new password must be different from your current password.',
      );
    }

    const client =
      this.supabase.createClient();

    /*
     * Do not trust the requested new email when checking the password.
     *
     * Reauthentication always uses the email from the already-authenticated
     * Supabase user attached by AuthGuard.
     */
    const {
      data: signInData,
      error: signInError,
    } = await client.auth.signInWithPassword({
      email: currentEmail,
      password: input.currentPassword,
    });

    if (signInError) {
      this.throwCurrentPasswordError(
        signInError.status,
      );
    }

    if (
      !signInData.session ||
      !signInData.user
    ) {
      throw new UnauthorizedException(
        'Your current password could not be verified.',
      );
    }

    const temporarySession =
      signInData.session;

    /*
     * Defense in depth: the password verification must resolve to the same
     * Supabase account that AuthGuard authenticated.
     */
    if (
      signInData.user.id !==
      authUser.id
    ) {
      await this.revokeTemporarySession(
        temporarySession.access_token,
        'local',
      );

      throw new UnauthorizedException(
        'Your current password could not be verified.',
      );
    }

    const attributes = {
      ...(emailChanged
        ? {
            email: input.email,
          }
        : {}),
      ...(passwordChanged
        ? {
            password:
              input.newPassword,
            current_password:
              input.currentPassword,
          }
        : {}),
    };

    try {
      const {
        data: updateData,
        error: updateError,
      } =
        await client.auth.updateUser(
          attributes,
        );

      if (updateError) {
        this.throwUpdateError(
          updateError.status,
          updateError.code,
        );
      }

      if (!updateData.user) {
        throw new ServiceUnavailableException(
          'The credential update did not return an account.',
        );
      }

      if (passwordChanged) {
        /*
         * Password changes are security-sensitive. Explicitly revoke
         * refresh sessions after the update as an additional safeguard.
         *
         * Already-issued JWT access tokens may remain usable until their
         * normal expiry.
         */
        await this.revokeTemporarySession(
          temporarySession.access_token,
          'global',
        );
      } else {
        /*
         * signInWithPassword above created a short-lived backend-only
         * session solely for reauthentication. Do not leave that extra
         * session active after requesting an email change.
         */
        await this.revokeTemporarySession(
          temporarySession.access_token,
          'local',
        );
      }

      if (emailChanged) {
        return {
          status:
            'confirmation_required',
          ...(passwordChanged
            ? {
                passwordUpdated:
                  true as const,
              }
            : {}),
        };
      }

      return {
        status:
          'password_updated',
      };
    } catch (error: unknown) {
      /*
       * If the provider rejected the update, clean up the temporary
       * reauthentication session.
       */
      if (!passwordChanged) {
        await this.revokeTemporarySession(
          temporarySession.access_token,
          'local',
        );
      }

      if (
        error instanceof HttpException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Unable to update your sign-in details right now.',
      );
    }
  }

  private throwCurrentPasswordError(
    status?: number,
  ): never {
    if (status === 429) {
      throw new HttpException(
        'Too many attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      !status ||
      status >= 500
    ) {
      throw new ServiceUnavailableException(
        'Authentication is temporarily unavailable.',
      );
    }

    throw new UnauthorizedException(
      'Your current password is incorrect.',
    );
  }

  private throwUpdateError(
    status?: number,
    code?: string,
  ): never {
    if (status === 429) {
      throw new HttpException(
        'Too many credential-change requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (code === 'weak_password') {
      throw new UnprocessableEntityException(
        'Choose a stronger password that meets the password policy.',
      );
    }

    if (
      code === 'email_exists' ||
      code === 'user_already_exists'
    ) {
      throw new ConflictException(
        'That email address cannot be used for this account.',
      );
    }

    if (
      !status ||
      status >= 500
    ) {
      throw new ServiceUnavailableException(
        'The authentication service is temporarily unavailable.',
      );
    }

    throw new UnprocessableEntityException(
      'Unable to update those sign-in details.',
    );
  }

  private async revokeTemporarySession(
    accessToken: string,
    scope: 'local' | 'global',
  ): Promise<void> {
    try {
      const admin =
        this.supabase.createAdminClient();

      const { error } =
        await admin.auth.admin.signOut(
          accessToken,
          scope,
        );

      if (error) {
        this.logger.warn(
          `Credential update succeeded, but ${scope} session revocation returned an error.`,
        );
      }
    } catch {
      this.logger.warn(
        `Credential update succeeded, but ${scope} session revocation was unavailable.`,
      );
    }
  }
}