import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

type PublicProfileRow = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

type FriendshipRow = {
  user_a_id: string;
  user_b_id: string;
  created_at: string;
};

type FriendRequestRow = {
  id: string;
  sender_id: string;
  recipient_id: string;
  created_at: string;
};

type BlockRow = {
  blocker_id: string;
  blocked_id: string;
};

type RpcResult = {
  status?: string;
  requestId?: string;
};

export type FriendPerson = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
};

@Injectable()
export class FriendsService {
  constructor(
    private readonly supabase: SupabaseService,
  ) {}

  async listFriends(
    userId: string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('friendships')
      .select(
        'user_a_id, user_b_id, created_at',
      )
      .or(
        `user_a_id.eq.${userId},user_b_id.eq.${userId}`,
      )
      .order(
        'created_at',
        {
          ascending: false,
        },
      );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load your friends right now.',
      );
    }

    const rows =
      (data ?? []) as FriendshipRow[];

    const friendIds =
      rows.map((row) =>
        row.user_a_id ===
        userId
          ? row.user_b_id
          : row.user_a_id,
      );

    const profiles =
      await this.loadProfiles(
        friendIds,
      );

    return {
      friends: rows
        .map((row) => {
          const otherId =
            row.user_a_id ===
            userId
              ? row.user_b_id
              : row.user_a_id;

          const profile =
            profiles.get(
              otherId,
            );

          if (!profile) {
            return null;
          }

          return {
            ...this.toPerson(
              profile,
            ),
            friendsSince:
              row.created_at,
          };
        })
        .filter(
          (
            value,
          ): value is FriendPerson & {
            friendsSince: string;
          } =>
            value !== null,
        ),
    };
  }

  async listRequests(
    userId: string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from(
        'friend_requests',
      )
      .select(
        'id, sender_id, recipient_id, created_at',
      )
      .or(
        `sender_id.eq.${userId},recipient_id.eq.${userId}`,
      )
      .order(
        'created_at',
        {
          ascending: false,
        },
      );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load friend requests right now.',
      );
    }

    const rows =
      (data ?? []) as FriendRequestRow[];

    const relatedIds =
      rows.map((row) =>
        row.sender_id ===
        userId
          ? row.recipient_id
          : row.sender_id,
      );

    const profiles =
      await this.loadProfiles(
        relatedIds,
      );

    const incoming = [];
    const outgoing = [];

    for (
      const row of rows
    ) {
      const otherId =
        row.sender_id ===
        userId
          ? row.recipient_id
          : row.sender_id;

      const profile =
        profiles.get(
          otherId,
        );

      if (!profile) {
        continue;
      }

      const item = {
        id: row.id,
        user:
          this.toPerson(
            profile,
          ),
        createdAt:
          row.created_at,
      };

      if (
        row.recipient_id ===
        userId
      ) {
        incoming.push(item);
      } else {
        outgoing.push(item);
      }
    }

    return {
      incoming,
      outgoing,
    };
  }

  async search(
    userId: string,
    query: string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const pattern =
      `%${query}%`;

    const [
      byUsername,
      byName,
      blocksResult,
      friendshipsResult,
      requestsResult,
    ] = await Promise.all([
      admin
        .from('profiles')
        .select(
          'user_id, username, display_name, avatar_url',
        )
        .eq(
          'is_discoverable',
          true,
        )
        .neq(
          'user_id',
          userId,
        )
        .ilike(
          'username',
          pattern,
        )
        .limit(20),

      admin
        .from('profiles')
        .select(
          'user_id, username, display_name, avatar_url',
        )
        .eq(
          'is_discoverable',
          true,
        )
        .neq(
          'user_id',
          userId,
        )
        .ilike(
          'display_name',
          pattern,
        )
        .limit(20),

      admin
        .from(
          'user_blocks',
        )
        .select(
          'blocker_id, blocked_id',
        )
        .or(
          `blocker_id.eq.${userId},blocked_id.eq.${userId}`,
        ),

      admin
        .from(
          'friendships',
        )
        .select(
          'user_a_id, user_b_id, created_at',
        )
        .or(
          `user_a_id.eq.${userId},user_b_id.eq.${userId}`,
        ),

      admin
        .from(
          'friend_requests',
        )
        .select(
          'id, sender_id, recipient_id, created_at',
        )
        .or(
          `sender_id.eq.${userId},recipient_id.eq.${userId}`,
        ),
    ]);

    if (
      byUsername.error ||
      byName.error ||
      blocksResult.error ||
      friendshipsResult.error ||
      requestsResult.error
    ) {
      throw new ServiceUnavailableException(
        'Unable to search for people right now.',
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
      new Set<string>();

    for (
      const row of
        (friendshipsResult.data ??
          []) as FriendshipRow[]
    ) {
      friendIds.add(
        row.user_a_id ===
        userId
          ? row.user_b_id
          : row.user_a_id,
      );
    }

    const incoming =
      new Set<string>();

    const outgoing =
      new Set<string>();

    for (
      const row of
        (requestsResult.data ??
          []) as FriendRequestRow[]
    ) {
      if (
        row.recipient_id ===
        userId
      ) {
        incoming.add(
          row.sender_id,
        );
      } else {
        outgoing.add(
          row.recipient_id,
        );
      }
    }

    const merged =
      new Map<
        string,
        PublicProfileRow
      >();

    for (
      const row of [
        ...((byUsername.data ??
          []) as PublicProfileRow[]),
        ...((byName.data ??
          []) as PublicProfileRow[]),
      ]
    ) {
      if (
        !blockedIds.has(
          row.user_id,
        )
      ) {
        merged.set(
          row.user_id,
          row,
        );
      }
    }

    const normalized =
      query.toLowerCase();

    const results =
      [...merged.values()]
        .sort((a, b) => {
          const aExact =
            a.username ===
            normalized
              ? 0
              : 1;

          const bExact =
            b.username ===
            normalized
              ? 0
              : 1;

          if (
            aExact !==
            bExact
          ) {
            return (
              aExact -
              bExact
            );
          }

          return a.username.localeCompare(
            b.username,
          );
        })
        .slice(0, 20)
        .map((profile) => ({
          ...this.toPerson(
            profile,
          ),
          relationship:
            friendIds.has(
              profile.user_id,
            )
              ? 'friends'
              : incoming.has(
                    profile.user_id,
                  )
                ? 'incoming_request'
                : outgoing.has(
                      profile.user_id,
                    )
                  ? 'outgoing_request'
                  : 'none',
        }));

    return {
      results,
    };
  }

  async sendRequest(
    senderId: string,
    recipientId: string,
  ) {
    if (
      senderId ===
      recipientId
    ) {
      throw new BadRequestException(
        'You cannot send a friend request to yourself.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'send_friend_request',
      {
        p_sender_id:
          senderId,
        p_recipient_id:
          recipientId,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to send the friend request right now.',
      );
    }

    const result =
      data as RpcResult;

    switch (
      result.status
    ) {
      case 'sent':
        return {
          status:
            'sent' as const,
          requestId:
            result.requestId,
        };

      case 'pending':
        return {
          status:
            'pending' as const,
        };

      case 'already_friends':
        return {
          status:
            'already_friends' as const,
        };

      case 'blocked':
        /*
         * Deliberately do not reveal which user created the block.
         */
        throw new ConflictException(
          'Unable to send a friend request to this user.',
        );

      case 'invalid':
        throw new NotFoundException(
          'The requested user is not available.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to send the friend request right now.',
        );
    }
  }

  async respondRequest(
    actorId: string,
    requestId: string,
    accept: boolean,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'respond_friend_request',
      {
        p_request_id:
          requestId,
        p_actor_id:
          actorId,
        p_accept:
          accept,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to respond to the friend request right now.',
      );
    }

    const result =
      data as RpcResult;

    switch (
      result.status
    ) {
      case 'accepted':
        return {
          status:
            'accepted' as const,
        };

      case 'declined':
        return {
          status:
            'declined' as const,
        };

      case 'forbidden':
        throw new ForbiddenException(
          'You cannot respond to this friend request.',
        );

      case 'invalid':
        throw new NotFoundException(
          'Friend request not found.',
        );

      case 'blocked':
        throw new ConflictException(
          'This friend request can no longer be accepted.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to respond to the friend request right now.',
        );
    }
  }

  async cancelRequest(
    actorId: string,
    requestId: string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'cancel_friend_request',
      {
        p_request_id:
          requestId,
        p_actor_id:
          actorId,
      },
    );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to cancel the friend request right now.',
      );
    }

    if (
      data !== true
    ) {
      throw new NotFoundException(
        'Outgoing friend request not found.',
      );
    }

    return {
      status:
        'cancelled' as const,
    };
  }

  async removeFriend(
    actorId: string,
    otherId: string,
  ) {
    if (
      actorId ===
      otherId
    ) {
      throw new BadRequestException(
        'You cannot remove yourself as a friend.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'remove_friend',
      {
        p_actor_id:
          actorId,
        p_other_id:
          otherId,
      },
    );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to remove this friend right now.',
      );
    }

    if (
      data !== true
    ) {
      throw new NotFoundException(
        'Friendship not found.',
      );
    }

    return {
      status:
        'removed' as const,
    };
  }

  async blockUser(
    actorId: string,
    otherId: string,
  ) {
    if (
      actorId ===
      otherId
    ) {
      throw new BadRequestException(
        'You cannot block yourself.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'block_user',
      {
        p_blocker_id:
          actorId,
        p_blocked_id:
          otherId,
      },
    );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to block this user right now.',
      );
    }

    if (
      data !== true
    ) {
      throw new NotFoundException(
        'The requested user is not available.',
      );
    }

    return {
      status:
        'blocked' as const,
    };
  }

  async unblockUser(
    actorId: string,
    otherId: string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'unblock_user',
      {
        p_blocker_id:
          actorId,
        p_blocked_id:
          otherId,
      },
    );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to unblock this user right now.',
      );
    }

    if (
      data !== true
    ) {
      throw new NotFoundException(
        'Block not found.',
      );
    }

    return {
      status:
        'unblocked' as const,
    };
  }

  private async loadProfiles(
    ids: string[],
  ): Promise<
    Map<
      string,
      PublicProfileRow
    >
  > {
    const uniqueIds =
      [...new Set(ids)];

    if (
      uniqueIds.length ===
      0
    ) {
      return new Map();
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('profiles')
      .select(
        'user_id, username, display_name, avatar_url',
      )
      .in(
        'user_id',
        uniqueIds,
      );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load friend profiles right now.',
      );
    }

    return new Map(
      (
        (data ??
          []) as PublicProfileRow[]
      ).map(
        (profile) => [
          profile.user_id,
          profile,
        ],
      ),
    );
  }

  private toPerson(
    profile: PublicProfileRow,
  ): FriendPerson {
    return {
      id:
        profile.user_id,
      username:
        profile.username,
      displayName:
        profile.display_name,
      ...(profile.avatar_url
        ? {
            avatarUrl:
              profile.avatar_url,
          }
        : {}),
    };
  }
}