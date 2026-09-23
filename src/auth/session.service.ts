import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfileService } from '../me/profile.service';
import { RefreshDto } from './dto/refresh.dto';

@Injectable()
export class SessionService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly profiles: ProfileService,
  ) {}

  async refresh(input: RefreshDto) {
    try {
      const client =
        this.supabase.createClient();

      const { data, error } =
        await client.auth.refreshSession({
          refresh_token:
            input.refreshToken,
        });

      if (error) {
        this.throwProviderError(
          error.status,
        );
      }

      if (
        !data.session ||
        !data.user
      ) {
        throw new UnauthorizedException(
          'Please sign in again.',
        );
      }

      const user =
        await this.profiles.getUser(
          data.user,
        );

      return {
        accessToken:
          data.session.access_token,
        refreshToken:
          data.session.refresh_token,
        user,
      };
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async logout(
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
        this.throwProviderError(
          error.status,
        );
      }
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private throwProviderError(
    status?: number,
  ): never {
    if (status === 429) {
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!status || status >= 500) {
      throw new ServiceUnavailableException(
        'The authentication service is temporarily unavailable.',
      );
    }

    throw new UnauthorizedException(
      'Your session is invalid or expired. Please sign in again.',
    );
  }

  private rethrow(
    error: unknown,
  ): never {
    if (error instanceof HttpException) {
      throw error;
    }

    throw new ServiceUnavailableException(
      'Unable to reach the authentication service.',
    );
  }
}