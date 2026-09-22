import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class LoginService {
  constructor(private readonly supabase: SupabaseService) {}

  async login(input: LoginDto) {
    try {
      const client = this.supabase.createClient();

      const { data, error } = await client.auth.signInWithPassword({
        email: input.email,
        password: input.password,
      });

      if (error) {
        if (error.status === 429) {
          throw new HttpException(
            'Too many login attempts. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        if (!error.status || error.status >= 500) {
          throw new ServiceUnavailableException(
            'Login is temporarily unavailable. Please try again later.',
          );
        }

        throw new UnauthorizedException(
          'Unable to sign in. Check your email and password and ensure your email is verified.',
        );
      }

      if (!data.session || !data.user) {
        throw new ServiceUnavailableException(
          'Login did not produce a session.',
        );
      }

      const displayName: unknown = data.user.user_metadata.display_name;

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        user: {
          id: data.user.id,
          email: data.user.email ?? input.email,
          displayName:
            typeof displayName === 'string' ? displayName : '',
        },
      };
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Unable to reach the authentication service. Try again later.',
      );
    }
  }
}