import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

type RouletteRpcResult = {
  status?: string;
  selectedMemberId?: string;
  eligibleCount?: number;
};

export type RouletteResponse = {
  selectedMemberId: string;
};

@Injectable()
export class OutingsRouletteService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async spin(
    userId: string,
    outingId: string,
  ): Promise<RouletteResponse> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'spin_outing_roulette',
      {
        p_actor_id:
          userId,
        p_outing_id:
          outingId,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to run payer selection right now.',
      );
    }

    const result =
      data as RouletteRpcResult;

    switch (
      result.status
    ) {
      case 'selected':
      case 'already_selected': {
        if (
          typeof result.selectedMemberId !==
          'string'
        ) {
          throw new ServiceUnavailableException(
            'The selected member could not be loaded.',
          );
        }

        return {
          selectedMemberId:
            result.selectedMemberId,
        };
      }

      case 'insufficient_members':
        throw new ConflictException(
          'At least two active members must opt into payer selection before spinning.',
        );

      /*
       * Treat forbidden and missing outings
       * the same way so callers cannot probe
       * private outing IDs.
       */
      case 'forbidden':
      case 'not_found':
        throw new NotFoundException(
          'Outing not found.',
        );

      case 'inactive':
        throw new ConflictException(
          'Payer selection is not available for this outing.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to run payer selection.',
        );

      case 'unavailable':
        throw new ServiceUnavailableException(
          'Unable to select an eligible member right now.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to run payer selection right now.',
        );
    }
  }
}