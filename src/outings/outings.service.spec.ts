import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { OutingsService } from './outings.service';

describe(
  'OutingsService',
  () => {
    let service:
      OutingsService;

    const from =
      jest.fn();

    const userA =
      '11111111-1111-4111-8111-111111111111';

    const outingA =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const memberA =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    beforeEach(
      async () => {
        jest.resetAllMocks();

        const module =
          await Test.createTestingModule(
            {
              providers: [
                OutingsService,
                {
                  provide:
                    SupabaseService,
                  useValue: {
                    createAdminClient:
                      () => ({
                        from,
                      }),
                  },
                },
              ],
            },
          ).compile();

        service =
          module.get(
            OutingsService,
          );
      },
    );

    it('creates an outing and returns the creator membership', async () => {
      const insert =
        jest.fn();

      const selectAfterInsert =
        jest.fn();

      const single =
        jest.fn();

      insert.mockReturnValue({
        select:
          selectAfterInsert,
      });

      selectAfterInsert.mockReturnValue({
        single,
      });

      single.mockResolvedValue({
        data: {
          id: outingA,
          created_by_user_id:
            userA,
          title:
            'Dinner',
          location:
            'Victoria Island',
          starts_at:
            '2099-10-01T18:00:00.000Z',
          currency:
            'NGN',
          amount_minor:
            500000,
          selected_member_id:
            null,
          status:
            'active',
          created_at:
            '2026-09-23T12:00:00.000Z',
        },
        error: null,
      });

      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'outings'
          ) {
            return {
              insert,
            };
          }

          if (
            table ===
            'outing_members'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  in: jest
                    .fn()
                    .mockReturnValue({
                      is: jest
                        .fn()
                        .mockReturnValue({
                          order:
                            jest
                              .fn()
                              .mockResolvedValue({
                                data: [
                                  {
                                    id:
                                      memberA,
                                    outing_id:
                                      outingA,
                                    user_id:
                                      userA,
                                    guest_display_name:
                                      null,
                                    role:
                                      'owner',
                                    opted_in:
                                      false,
                                    joined_at:
                                      '2026-09-23T12:00:00.000Z',
                                    removed_at:
                                      null,
                                  },
                                ],
                                error:
                                  null,
                              }),
                        }),
                    }),
                }),
            };
          }

          if (
            table ===
            'profiles'
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
                            userA,
                          display_name:
                            'Samuel',
                        },
                      ],
                      error:
                        null,
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
        await service.create(
          userA,
          {
            title:
              'Dinner',
            location:
              'Victoria Island',
            startsAt:
              '2099-10-01T18:00:00.000Z',
            currency:
              'NGN',
            amountMinor:
              500000,
          },
        );

      expect(
        insert,
      ).toHaveBeenCalledWith(
        {
          created_by_user_id:
            userA,
          title:
            'Dinner',
          location:
            'Victoria Island',
          starts_at:
            '2099-10-01T18:00:00.000Z',
          currency:
            'NGN',
          amount_minor:
            500000,
        },
      );

      expect(result).toEqual({
        id: outingA,
        title: 'Dinner',
        location:
          'Victoria Island',
        startsAt:
          '2099-10-01T18:00:00.000Z',
        currency: 'NGN',
        amountMinor:
          500000,
        members: [
          {
            id:
              memberA,
            displayName:
              'Samuel',
            optedIn:
              false,
          },
        ],
      });
    });

    it('rejects an outing in the past before querying the database', async () => {
      await expect(
        service.create(
          userA,
          {
            title:
              'Old outing',
            location:
              'Lagos',
            startsAt:
              '2020-01-01T10:00:00.000Z',
            currency:
              'NGN',
            amountMinor:
              0,
          },
        ),
      ).rejects.toMatchObject({
        status: 400,
      });

      expect(
        from,
      ).not.toHaveBeenCalled();
    });

    it('returns an empty list when the user has no outings', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table !==
            'outing_members'
          ) {
            throw new Error(
              `Unexpected table ${table}`,
            );
          }

          return {
            select: jest
              .fn()
              .mockReturnValue({
                eq: jest
                  .fn()
                  .mockReturnValue({
                    is: jest
                      .fn()
                      .mockReturnValue({
                        order:
                          jest
                            .fn()
                            .mockResolvedValue({
                              data: [],
                              error:
                                null,
                            }),
                      }),
                  }),
              }),
          };
        },
      );

      await expect(
        service.list(
          userA,
        ),
      ).resolves.toEqual({
        outings: [],
      });
    });

    it('does not expose an outing to a non-member', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table !==
            'outing_members'
          ) {
            throw new Error(
              `Unexpected table ${table}`,
            );
          }

          return {
            select: jest
              .fn()
              .mockReturnValue({
                eq: jest
                  .fn()
                  .mockReturnValue({
                    eq: jest
                      .fn()
                      .mockReturnValue({
                        is: jest
                          .fn()
                          .mockReturnValue({
                            maybeSingle:
                              jest
                                .fn()
                                .mockResolvedValue({
                                  data:
                                    null,
                                  error:
                                    null,
                                }),
                          }),
                      }),
                  }),
              }),
          };
        },
      );

      await expect(
        service.get(
          userA,
          outingA,
        ),
      ).rejects.toMatchObject({
        status: 404,
        message:
          'Outing not found.',
      });
    });

    it('returns 503 when memberships cannot be loaded', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table !==
            'outing_members'
          ) {
            throw new Error(
              `Unexpected table ${table}`,
            );
          }

          return {
            select: jest
              .fn()
              .mockReturnValue({
                eq: jest
                  .fn()
                  .mockReturnValue({
                    is: jest
                      .fn()
                      .mockReturnValue({
                        order:
                          jest
                            .fn()
                            .mockResolvedValue({
                              data: null,
                              error: {
                                message:
                                  'database unavailable',
                              },
                            }),
                      }),
                  }),
              }),
          };
        },
      );

      await expect(
        service.list(
          userA,
        ),
      ).rejects.toMatchObject({
        status: 503,
      });
    });
  },
);