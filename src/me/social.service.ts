import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SocialSettingsDto } from './dto/social-settings.dto';

type SocialProfileRow = {
  username: string;
  is_discoverable: boolean;
};

@Injectable()
export class SocialService {
  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  async getSettings(
    userId: string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('profiles')
      .select(
        'username, is_discoverable',
      )
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      throw new ServiceUnavailableException(
        'Unable to load your social settings right now.',
      );
    }

    const profile =
      data as SocialProfileRow;

    return {
      username:
        profile.username,
      isDiscoverable:
        profile.is_discoverable,
    };
  }

  async updateSettings(
    userId: string,
    input: SocialSettingsDto,
  ) {
    if (
      input.username === undefined &&
      input.isDiscoverable === undefined
    ) {
      throw new BadRequestException(
        'Provide at least one social setting to update.',
      );
    }

    const updates: {
      username?: string;
      is_discoverable?: boolean;
    } = {};

    if (
      input.username !==
      undefined
    ) {
      updates.username =
        input.username;
    }

    if (
      input.isDiscoverable !==
      undefined
    ) {
      updates.is_discoverable =
        input.isDiscoverable;
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('profiles')
      .update(updates)
      .eq('user_id', userId)
      .select(
        'username, is_discoverable',
      )
      .single();

    if (error) {
      if (
        error.code === '23505'
      ) {
        throw new ConflictException(
          'That username is already in use.',
        );
      }

      throw new ServiceUnavailableException(
        'Unable to update your social settings right now.',
      );
    }

    if (!data) {
      throw new ServiceUnavailableException(
        'Unable to update your social settings right now.',
      );
    }

    const profile =
      data as SocialProfileRow;

    return {
      username:
        profile.username,
      isDiscoverable:
        profile.is_discoverable,
    };
  }
}