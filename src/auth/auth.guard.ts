import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';

export type AuthenticatedRequest = Request & {
  authUser: User;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);

    if (!match) {
      throw new UnauthorizedException('A bearer access token is required.');
    }

    try {
      const client = this.supabase.createClient();

      const { data, error } = await client.auth.getUser(match[1]);

      if (error) {
        if (!error.status || error.status >= 500 || error.status === 429) {
          throw new ServiceUnavailableException(
            'Authentication is temporarily unavailable.',
          );
        }

        throw new UnauthorizedException(
          'Your session is invalid or expired. Please sign in again.',
        );
      }

      if (!data.user) {
        throw new UnauthorizedException('Please sign in again.');
      }

      request.authUser = data.user;
      return true;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Unable to reach the authentication service.',
      );
    }
  }
}