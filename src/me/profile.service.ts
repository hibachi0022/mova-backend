import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

type ProfileRow = {
  user_id: string;
  display_name: string;
  phone: string | null;
  avatar_url: string | null;
};

export type MovaUser = {
  id: string;
  email: string;
  displayName: string;
  phone?: string;
  avatarUrl?: string;
};

@Injectable()
export class ProfileService {
  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  async getUser(
    user: User,
  ): Promise<MovaUser> {
    const profile =
      await this.getOrCreateProfile(
        user,
      );

    return this.toUserResponse(
      user,
      profile,
    );
  }

  async updateUser(
    user: User,
    input: UpdateProfileDto,
  ): Promise<MovaUser> {
    if (
      input.displayName === undefined &&
      input.phone === undefined
    ) {
      throw new BadRequestException(
        'Provide at least one profile field to update.',
      );
    }

    const updates: {
      display_name?: string;
      phone?: string | null;
    } = {};

    if (
      input.displayName !==
      undefined
    ) {
      updates.display_name =
        input.displayName;
    }

    if (
      input.phone !==
      undefined
    ) {
      updates.phone =
        input.phone;
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('profiles')
      .update(updates)
      .eq(
        'user_id',
        user.id,
      )
      .select(
        'user_id, display_name, phone, avatar_url',
      )
      .single();

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to update your profile right now.',
      );
    }

    return this.toUserResponse(
      user,
      data as ProfileRow,
    );
  }

  private async getOrCreateProfile(
    user: User,
  ): Promise<ProfileRow> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('profiles')
      .select(
        'user_id, display_name, phone, avatar_url',
      )
      .eq(
        'user_id',
        user.id,
      )
      .maybeSingle();

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load your profile right now.',
      );
    }

    if (data) {
      return data as ProfileRow;
    }

    const metadataDisplayName:
      unknown =
      user.user_metadata
        .display_name;

    const fallbackDisplayName =
      typeof metadataDisplayName ===
        'string' &&
      metadataDisplayName
        .trim()
        .length >= 2 &&
      metadataDisplayName
        .trim()
        .length <= 50
        ? metadataDisplayName.trim()
        : 'Mova User';

    /*
     * username became NOT NULL when the Friends foundation was added.
     *
     * Match the Auth-user database trigger's deterministic starter-handle
     * format so this fallback remains valid.
     */
    const fallbackUsername =
      `mova_${user.id
        .replace(/-/g, '')
        .slice(0, 24)}`;

    const {
      data: created,
      error: createError,
    } = await admin
      .from('profiles')
      .insert({
        user_id:
          user.id,
        display_name:
          fallbackDisplayName,
        username:
          fallbackUsername,
      })
      .select(
        'user_id, display_name, phone, avatar_url',
      )
      .single();

    if (
      createError ||
      !created
    ) {
      const {
        data: retry,
        error:
          retryError,
      } = await admin
        .from('profiles')
        .select(
          'user_id, display_name, phone, avatar_url',
        )
        .eq(
          'user_id',
          user.id,
        )
        .maybeSingle();

      if (
        retryError ||
        !retry
      ) {
        throw new ServiceUnavailableException(
          'Unable to prepare your profile right now.',
        );
      }

      return retry as ProfileRow;
    }

    return created as ProfileRow;
  }

  private toUserResponse(
    user: User,
    profile: ProfileRow,
  ): MovaUser {
    return {
      id: user.id,
      email:
        user.email ?? '',
      displayName:
        profile.display_name,
      ...(profile.phone
        ? {
            phone:
              profile.phone,
          }
        : {}),
      ...(profile.avatar_url
        ? {
            avatarUrl:
              profile.avatar_url,
          }
        : {}),
    };
  }
}