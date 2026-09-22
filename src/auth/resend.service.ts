import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ResendDto } from './dto/resend.dto';

type ResendReservation = {
  status: 'ready' | 'cooldown' | 'invalid';
  email?: string;
};

@Injectable()
export class ResendService {
  constructor(private readonly supabase: SupabaseService) {}

  async resend(input: ResendDto) {
    try {
      const admin = this.supabase.createAdminClient();

      const { data, error: reservationError } = await admin.rpc(
        'reserve_signup_resend',
        {
          p_challenge_id: input.challengeId,
        },
      );

      if (reservationError || !data) {
        throw new ServiceUnavailableException(
          'Unable to prepare a new verification email.',
        );
      }

      const reservation = data as ResendReservation;

      if (reservation.status === 'cooldown') {
        throw new HttpException(
          'Please wait 60 seconds between resend requests.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (reservation.status === 'invalid') {
        throw new BadRequestException(
          'This verification request cannot be reused. Sign in if already verified, or restart signup.',
        );
      }

      if (
        reservation.status !== 'ready' ||
        typeof reservation.email !== 'string'
      ) {
        throw new ServiceUnavailableException(
          'Unable to prepare a new verification email.',
        );
      }

      const client = this.supabase.createClient();

      const { error } = await client.auth.resend({
        type: 'signup',
        email: reservation.email,
      });

      if (error) {
        if (error.status === 429) {
          throw new HttpException(
            'Email sending is rate limited. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        throw new ServiceUnavailableException(
          'Unable to request a new verification email. Please try again later.',
        );
      }

      const { data: renewed, error: renewalError } = await admin.rpc(
        'finish_signup_resend',
        {
          p_challenge_id: input.challengeId,
        },
      );

      if (renewalError) {
        throw new ServiceUnavailableException(
          'Unable to renew the verification request.',
        );
      }

      if (renewed !== true) {
        throw new BadRequestException(
          'This verification request is no longer available.',
        );
      }

      return {
        challengeId: input.challengeId,
        message:
          'If the account is awaiting verification, a new code has been requested.',
      };
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'The authentication service is temporarily unavailable.',
      );
    }
  }
}