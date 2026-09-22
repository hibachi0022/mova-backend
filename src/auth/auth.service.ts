import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { SignupDto } from './dto/signup.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async signup(input: SignupDto): Promise<{ challengeId: string }> {
    const admin = this.supabase.createAdminClient();
    const challengeId = randomUUID();

    const { error: storageError } = await admin
      .from('auth_challenges')
      .insert({
        id: challengeId,
        email: input.email,
        purpose: 'signup',
      });

    if (storageError) {
      this.logger.error('Unable to create signup challenge.');

      throw new ServiceUnavailableException(
        'Signup is temporarily unavailable. Please try again later.',
      );
    }

    try {
      const client = this.supabase.createClient();

      const { data, error } = await client.auth.signUp({
        email: input.email,
        password: input.password,
        options: {
          data: {
            display_name: input.displayName,
          },
        },
      });

      if (error) {
        // Keep the response generic for an existing account.
        if (error.code === 'user_already_exists') {
          return { challengeId };
        }

        if (error.status === 429) {
          throw new HttpException(
            'Too many signup attempts. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        if (error.code === 'weak_password') {
          throw new UnprocessableEntityException(
            'Choose a stronger password that meets the password policy.',
          );
        }

        this.logger.warn('Supabase could not complete signup.');

        throw new ServiceUnavailableException(
          'Unable to complete signup. Check email delivery configuration.',
        );
      }

      if (data.session) {
        this.logger.error(
          'Email confirmation must be enabled in Supabase.',
        );

        throw new ServiceUnavailableException(
          'Signup verification is not configured correctly.',
        );
      }

      return { challengeId };
    } catch (error: unknown) {
      const { error: cleanupError } = await admin
        .from('auth_challenges')
        .delete()
        .eq('id', challengeId);

      if (cleanupError) {
        this.logger.error('Unable to remove failed signup challenge.');
      }

      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Unable to reach the authentication service. Try again later.',
      );
    }
  }
}