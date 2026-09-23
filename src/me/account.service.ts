import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

@Injectable()
export class AccountService {
  private readonly logger =
    new Logger(AccountService.name);

  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  async deleteAccount(
    authUser: User,
    input: DeleteAccountDto,
  ): Promise<{
    status: 'deleted';
  }> {
    const currentEmail =
      authUser.email
        ?.trim()
        .toLowerCase();

    if (!currentEmail) {
      throw new BadRequestException(
        'This account does not have an email address that can be reauthenticated.',
      );
    }

    const client =
      this.supabase.createClient();

    /*
     * Reauthenticate using the email from AuthGuard's already-authenticated
     * Supabase user.
     *
     * Never accept an email from the deletion request itself.
     */
    const {
      data: signInData,
      error: signInError,
    } =
      await client.auth.signInWithPassword({
        email: currentEmail,
        password:
          input.currentPassword,
      });

    if (signInError) {
      this.throwReauthenticationError(
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

    const temporaryAccessToken =
      signInData.session.access_token;

    /*
     * Defense in depth:
     * the password must resolve to exactly the same Supabase user that
     * AuthGuard authenticated.
     */
    if (
      signInData.user.id !==
      authUser.id
    ) {
      await this.revokeTemporarySession(
        temporaryAccessToken,
      );

      throw new UnauthorizedException(
        'Your current password could not be verified.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    try {
      /*
       * Deleting auth.users is the authoritative account deletion.
       *
       * public.profiles.user_id uses ON DELETE CASCADE, so the profile row
       * is removed automatically by PostgreSQL when this succeeds.
       */
      const { error: deleteError } =
        await admin.auth.admin.deleteUser(
          authUser.id,
        );

      if (deleteError) {
        this.throwDeletionError(
          deleteError.status,
        );
      }

      /*
       * There is no reason to separately sign out the temporary session
       * after successful deletion: its owning Auth user no longer exists.
       */
      return {
        status: 'deleted',
      };
    } catch (error: unknown) {
      /*
       * If deletion failed, the account still exists.
       * Revoke the backend-only reauthentication session that we created
       * solely to verify the current password.
       */
      await this.revokeTemporarySession(
        temporaryAccessToken,
      );

      if (
        error instanceof HttpException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Unable to delete your account right now.',
      );
    }
  }

  private throwReauthenticationError(
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

  private throwDeletionError(
    status?: number,
  ): never {
    if (status === 429) {
      throw new HttpException(
        'Too many account deletion requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    /*
     * Supabase can reject deletion when dependent resources such as owned
     * Storage objects still exist.
     */
    if (
      status === 400 ||
      status === 409
    ) {
      throw new ConflictException(
        'Your account cannot be deleted while dependent resources still exist.',
      );
    }

    if (
      status === 401 ||
      status === 404
    ) {
      throw new UnauthorizedException(
        'This account is no longer available.',
      );
    }

    if (
      !status ||
      status >= 500
    ) {
      throw new ServiceUnavailableException(
        'Account deletion is temporarily unavailable.',
      );
    }

    throw new ServiceUnavailableException(
      'Unable to delete your account right now.',
    );
  }

  private async revokeTemporarySession(
    accessToken: string,
  ): Promise<void> {
    try {
      const admin =
        this.supabase.createAdminClient();

      const { error } =
        await admin.auth.admin.signOut(
          accessToken,
          'local',
        );

      if (error) {
        this.logger.warn(
          'Unable to revoke the temporary account-deletion session.',
        );
      }
    } catch {
      this.logger.warn(
        'Temporary account-deletion session revocation was unavailable.',
      );
    }
  }
}