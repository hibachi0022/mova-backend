import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

type FriendshipRow = {
  user_a_id: string;
  user_b_id: string;
};

type BlockRow = {
  blocker_id: string;
  blocked_id: string;
};

type RecipientProfileRow = {
  user_id: string;
  display_name: string;
  username: string;
};

export type PaymentRecipient = {
  id: string;
  displayName: string;
  username: string;
};

@Injectable()
export class PaymentRecipientsService {
  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  async listRecipients(
    userId: string,
  ): Promise<{
    recipients: PaymentRecipient[];
  }> {
    const admin =
      this.supabase.createAdminClient();

    const [
      friendshipsResult,
      blocksResult,
    ] = await Promise.all([
      admin
        .from('friendships')
        .select(
          'user_a_id, user_b_id',
        )
        .or(
          `user_a_id.eq.${userId},user_b_id.eq.${userId}`,
        ),

      admin
        .from('user_blocks')
        .select(
          'blocker_id, blocked_id',
        )
        .or(
          `blocker_id.eq.${userId},blocked_id.eq.${userId}`,
        ),
    ]);

    if (
      friendshipsResult.error ||
      blocksResult.error
    ) {
      throw new ServiceUnavailableException(
        'Unable to load payment recipients right now.',
      );
    }

    const blockedIds =
      new Set<string>();

    for (
      const row of
        (blocksResult.data ??
          []) as BlockRow[]
    ) {
      blockedIds.add(
        row.blocker_id ===
        userId
          ? row.blocked_id
          : row.blocker_id,
      );
    }

    const friendIds =
      [
        ...new Set(
          (
            (friendshipsResult.data ??
              []) as FriendshipRow[]
          )
            .map((row) =>
              row.user_a_id ===
              userId
                ? row.user_b_id
                : row.user_a_id,
            )
            .filter(
              (friendId) =>
                !blockedIds.has(
                  friendId,
                ),
            ),
        ),
      ];

    if (
      friendIds.length ===
      0
    ) {
      return {
        recipients: [],
      };
    }

    const {
      data,
      error,
    } = await admin
      .from('profiles')
      .select(
        'user_id, display_name, username',
      )
      .in(
        'user_id',
        friendIds,
      );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load payment recipients right now.',
      );
    }

    const recipients =
      (
        (data ??
          []) as RecipientProfileRow[]
      )
        .map(
          (
            profile,
          ): PaymentRecipient => ({
            id:
              profile.user_id,
            displayName:
              profile.display_name,
            username:
              profile.username,
          }),
        )
        .sort((a, b) => {
          const nameOrder =
            a.displayName.localeCompare(
              b.displayName,
              undefined,
              {
                sensitivity:
                  'base',
              },
            );

          if (
            nameOrder !== 0
          ) {
            return nameOrder;
          }

          return a.username.localeCompare(
            b.username,
          );
        });

    return {
      recipients,
    };
  }
}