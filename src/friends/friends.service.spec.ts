import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { FriendsService } from './friends.service';

describe('FriendsService', () => {
  let service: FriendsService;

  const from = jest.fn();
  const rpc = jest.fn();

  const userA =
    '11111111-1111-4111-8111-111111111111';

  const userB =
    '22222222-2222-4222-8222-222222222222';

  const userC =
    '33333333-3333-4333-8333-333333333333';

  const userD =
    '44444444-4444-4444-8444-444444444444';

  const userE =
    '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    jest.resetAllMocks();

    const module =
      await Test.createTestingModule({
        providers: [
          FriendsService,
          {
            provide: SupabaseService,
            useValue: {
              createAdminClient:
                () => ({
                  from,
                  rpc,
                }),
            },
          },
        ],
      }).compile();

    service =
      module.get(FriendsService);
  });

  it('lists accepted friends with profile details', async () => {
    from.mockImplementation(
      (table: string) => {
        if (
          table ===
          'friendships'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                or: jest
                  .fn()
                  .mockReturnValue({
                    order:
                      jest
                        .fn()
                        .mockResolvedValue({
                          data: [
                            {
                              user_a_id:
                                userA,
                              user_b_id:
                                userB,
                              created_at:
                                '2026-09-23T10:00:00.000Z',
                            },
                          ],
                          error: null,
                        }),
                  }),
              }),
          };
        }

        if (
          table === 'profiles'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                in: jest
                  .fn()
                  .mockResolvedValue({
                    data: [
                      {
                        user_id:
                          userB,
                        username:
                          'peter',
                        display_name:
                          'Peter',
                        avatar_url:
                          null,
                      },
                    ],
                    error: null,
                  }),
              }),
          };
        }

        throw new Error(
          `Unexpected table ${table}`,
        );
      },
    );

    const result =
      await service.listFriends(
        userA,
      );

    expect(result).toEqual({
      friends: [
        {
          id: userB,
          username:
            'peter',
          displayName:
            'Peter',
          friendsSince:
            '2026-09-23T10:00:00.000Z',
        },
      ],
    });
  });

  it('separates incoming and outgoing friend requests', async () => {
    from.mockImplementation(
      (table: string) => {
        if (
          table ===
          'friend_requests'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                or: jest
                  .fn()
                  .mockReturnValue({
                    order:
                      jest
                        .fn()
                        .mockResolvedValue({
                          data: [
                            {
                              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                              sender_id:
                                userB,
                              recipient_id:
                                userA,
                              created_at:
                                '2026-09-23T10:00:00.000Z',
                            },
                            {
                              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                              sender_id:
                                userA,
                              recipient_id:
                                userC,
                              created_at:
                                '2026-09-23T11:00:00.000Z',
                            },
                          ],
                          error: null,
                        }),
                  }),
              }),
          };
        }

        if (
          table === 'profiles'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                in: jest
                  .fn()
                  .mockResolvedValue({
                    data: [
                      {
                        user_id:
                          userB,
                        username:
                          'peter',
                        display_name:
                          'Peter',
                        avatar_url:
                          null,
                      },
                      {
                        user_id:
                          userC,
                        username:
                          'queen',
                        display_name:
                          'Queen',
                        avatar_url:
                          null,
                      },
                    ],
                    error: null,
                  }),
              }),
          };
        }

        throw new Error(
          `Unexpected table ${table}`,
        );
      },
    );

    const result =
      await service.listRequests(
        userA,
      );

    expect(
      result.incoming,
    ).toHaveLength(1);

    expect(
      result.outgoing,
    ).toHaveLength(1);

    expect(
      result.incoming[0],
    ).toMatchObject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: {
        id: userB,
        username:
          'peter',
      },
    });

    expect(
      result.outgoing[0],
    ).toMatchObject({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      user: {
        id: userC,
        username:
          'queen',
      },
    });
  });

  it('removes blocked users from search and maps relationship states', async () => {
    let profileSearchCall =
      0;

    from.mockImplementation(
      (table: string) => {
        if (
          table === 'profiles'
        ) {
          profileSearchCall +=
            1;

          const result =
            profileSearchCall ===
            1
              ? [
                  {
                    user_id:
                      userB,
                    username:
                      'samuelblocked',
                    display_name:
                      'Samuel Blocked',
                    avatar_url:
                      null,
                  },
                  {
                    user_id:
                      userC,
                    username:
                      'samuelfriend',
                    display_name:
                      'Samuel Friend',
                    avatar_url:
                      null,
                  },
                ]
              : [
                  {
                    user_id:
                      userD,
                    username:
                      'samuelpending',
                    display_name:
                      'Samuel Pending',
                    avatar_url:
                      null,
                  },
                  {
                    user_id:
                      userE,
                    username:
                      'samuelnew',
                    display_name:
                      'Samuel New',
                    avatar_url:
                      null,
                  },
                ];

          return {
            select: jest
              .fn()
              .mockReturnValue({
                eq: jest
                  .fn()
                  .mockReturnValue({
                    neq: jest
                      .fn()
                      .mockReturnValue({
                        ilike:
                          jest
                            .fn()
                            .mockReturnValue({
                              limit:
                                jest
                                  .fn()
                                  .mockResolvedValue({
                                    data:
                                      result,
                                    error:
                                      null,
                                  }),
                            }),
                      }),
                  }),
              }),
          };
        }

        if (
          table ===
          'user_blocks'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                or: jest
                  .fn()
                  .mockResolvedValue({
                    data: [
                      {
                        blocker_id:
                          userB,
                        blocked_id:
                          userA,
                      },
                    ],
                    error: null,
                  }),
              }),
          };
        }

        if (
          table ===
          'friendships'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                or: jest
                  .fn()
                  .mockResolvedValue({
                    data: [
                      {
                        user_a_id:
                          userA,
                        user_b_id:
                          userC,
                        created_at:
                          '2026-09-23T10:00:00.000Z',
                      },
                    ],
                    error: null,
                  }),
              }),
          };
        }

        if (
          table ===
          'friend_requests'
        ) {
          return {
            select: jest
              .fn()
              .mockReturnValue({
                or: jest
                  .fn()
                  .mockResolvedValue({
                    data: [
                      {
                        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                        sender_id:
                          userA,
                        recipient_id:
                          userD,
                        created_at:
                          '2026-09-23T11:00:00.000Z',
                      },
                    ],
                    error: null,
                  }),
              }),
          };
        }

        throw new Error(
          `Unexpected table ${table}`,
        );
      },
    );

    const result =
      await service.search(
        userA,
        'samuel',
      );

    expect(
      result.results.find(
        (person) =>
          person.id ===
          userB,
      ),
    ).toBeUndefined();

    expect(
      result.results,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: userC,
          relationship:
            'friends',
        }),
        expect.objectContaining({
          id: userD,
          relationship:
            'outgoing_request',
        }),
        expect.objectContaining({
          id: userE,
          relationship:
            'none',
        }),
      ]),
    );
  });

  it('maps a sent friend request', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'sent',
        requestId:
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      error: null,
    });

    const result =
      await service.sendRequest(
        userA,
        userB,
      );

    expect(rpc).toHaveBeenCalledWith(
      'send_friend_request',
      {
        p_sender_id:
          userA,
        p_recipient_id:
          userB,
      },
    );

    expect(result).toEqual({
      status: 'sent',
      requestId:
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('returns pending without creating another request', async () => {
    rpc.mockResolvedValue({
      data: {
        status:
          'pending',
      },
      error: null,
    });

    await expect(
      service.sendRequest(
        userA,
        userB,
      ),
    ).resolves.toEqual({
      status: 'pending',
    });
  });

  it('does not reveal block direction when request is blocked', async () => {
    rpc.mockResolvedValue({
      data: {
        status:
          'blocked',
      },
      error: null,
    });

    await expect(
      service.sendRequest(
        userA,
        userB,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'Unable to send a friend request to this user.',
    });
  });

  it('maps invalid friend-request target to 404', async () => {
    rpc.mockResolvedValue({
      data: {
        status:
          'invalid',
      },
      error: null,
    });

    await expect(
      service.sendRequest(
        userA,
        userB,
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('accepts an incoming friend request', async () => {
    rpc.mockResolvedValue({
      data: {
        status:
          'accepted',
      },
      error: null,
    });

    const result =
      await service.respondRequest(
        userA,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        true,
      );

    expect(rpc).toHaveBeenCalledWith(
      'respond_friend_request',
      {
        p_request_id:
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        p_actor_id:
          userA,
        p_accept:
          true,
      },
    );

    expect(result).toEqual({
      status:
        'accepted',
    });
  });

  it('declines an incoming friend request', async () => {
    rpc.mockResolvedValue({
      data: {
        status:
          'declined',
      },
      error: null,
    });

    await expect(
      service.respondRequest(
        userA,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        false,
      ),
    ).resolves.toEqual({
      status:
        'declined',
    });
  });

  it('returns 403 when the actor cannot respond to the request', async () => {
    rpc.mockResolvedValue({
      data: {
        status:
          'forbidden',
      },
      error: null,
    });

    await expect(
      service.respondRequest(
        userA,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        true,
      ),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('cancels an outgoing request', async () => {
    rpc.mockResolvedValue({
      data: true,
      error: null,
    });

    await expect(
      service.cancelRequest(
        userA,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).resolves.toEqual({
      status:
        'cancelled',
    });
  });

  it('returns 404 when cancelling another users request', async () => {
    rpc.mockResolvedValue({
      data: false,
      error: null,
    });

    await expect(
      service.cancelRequest(
        userA,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('removes an accepted friend', async () => {
    rpc.mockResolvedValue({
      data: true,
      error: null,
    });

    await expect(
      service.removeFriend(
        userA,
        userB,
      ),
    ).resolves.toEqual({
      status:
        'removed',
    });
  });

  it('prevents blocking yourself', async () => {
    await expect(
      service.blockUser(
        userA,
        userA,
      ),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('blocks another user', async () => {
    rpc.mockResolvedValue({
      data: true,
      error: null,
    });

    await expect(
      service.blockUser(
        userA,
        userB,
      ),
    ).resolves.toEqual({
      status:
        'blocked',
    });

    expect(rpc).toHaveBeenCalledWith(
      'block_user',
      {
        p_blocker_id:
          userA,
        p_blocked_id:
          userB,
      },
    );
  });

  it('unblocks another user', async () => {
    rpc.mockResolvedValue({
      data: true,
      error: null,
    });

    await expect(
      service.unblockUser(
        userA,
        userB,
      ),
    ).resolves.toEqual({
      status:
        'unblocked',
    });
  });

  it('returns 503 when an RPC fails', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        message:
          'database unavailable',
      },
    });

    await expect(
      service.sendRequest(
        userA,
        userB,
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});